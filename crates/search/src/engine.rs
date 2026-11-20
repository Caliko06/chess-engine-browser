//! Playing search, independent of Explore's root-relative analysis contracts.
//!
//! Standard PVS/LMR and TT design references (implementation written for this board API):
//! www.chessprogramming.org/Principal_Variation_Search
//! www.chessprogramming.org/Late_Move_Reductions
//! Weiss `search.c` / `transposition.c`, Blunder `engine/search.go`.
//! No clock or thread ownership: the caller supplies node/depth limits and a stop flag.

use chess_board::{Color, Move, MoveList, Piece, PieceKind, Position, PromotionPiece, Square};
use chess_eval::tapered::{PawnCache, evaluate_cached, evaluate_tapered};
use chess_eval::{BISHOP_VALUE, KNIGHT_VALUE, PAWN_VALUE, QUEEN_VALUE, ROOK_VALUE};
use std::sync::atomic::{AtomicBool, Ordering};

const MAX_PLY: usize = 128;
const MAX_MOVES: usize = MoveList::CAPACITY;
const MATE: i32 = 30_000;
const MATE_BOUND: i32 = MATE - MAX_PLY as i32;
const INF: i32 = 32_000;
const HISTORY_MAX: i32 = 16_384;
/// Marker that never compares below a real score, so a node after an in-check node is not improving.
const NO_EVAL: i32 = INF;
const BUCKET_SIZE: usize = 4;
/// Continuation history is keyed by the opponent's last (piece, to) and our (piece, to).
const PIECE_SQUARES: usize = 12 * 64;
const CONTINUATION_SIZE: usize = PIECE_SQUARES * PIECE_SQUARES;
const CAPTURE_HISTORY_SIZE: usize = PIECE_SQUARES * 6;
/// Static-eval cache slots: each holds the key's top 48 bits and the 16-bit eval (512 KB).
const EVAL_CACHE_SIZE: usize = 1 << 16;

pub struct EngineLimits<'a> {
    pub max_depth: Option<u8>,
    pub nodes: Option<u64>,
    pub stop: Option<&'a AtomicBool>,
}

#[derive(Clone, Debug)]
pub struct IterationInfo {
    pub depth: u8,
    pub seldepth: u8,
    /// Centipawns relative to the root side to move, including mate-band scores.
    pub score_cp: i32,
    pub mate_in: Option<i32>,
    pub nodes: u64,
    pub pv: Vec<Move>,
}

#[derive(Clone, Debug)]
pub struct EngineResult {
    pub best_move: Option<Move>,
    pub score_cp: i32,
    pub depth: u8,
    pub nodes: u64,
    pub pv: Vec<Move>,
}

/// One root move of a MultiPV search, scored from the root side to move.
#[derive(Clone, Debug)]
pub struct RootLine {
    pub mv: Move,
    pub score_cp: i32,
    pub mate_in: Option<i32>,
    /// Starts with `mv`.
    pub pv: Vec<Move>,
}

#[derive(Clone, Debug)]
pub struct MultiResult {
    /// Best first; empty only when the root has no legal move.
    pub lines: Vec<RootLine>,
    /// Last depth completed for every line (0 when the budget ran out inside depth 1).
    pub depth: u8,
    pub nodes: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Bound {
    Empty,
    Exact,
    Lower,
    Upper,
}

#[derive(Clone, Copy)]
struct Entry {
    key: u64,
    best: Option<Move>,
    score: i32,
    depth: i16,
    age: u8,
    bound: Bound,
}

impl Entry {
    const EMPTY: Self = Self {
        key: 0,
        best: None,
        score: 0,
        depth: 0,
        age: 0,
        bound: Bound::Empty,
    };
}

/// Move buffers for one ply, reused across nodes so a node never re-initialises ~5 KB of lists.
struct Frame {
    moves: MoveList,
    scores: [i32; MAX_MOVES],
    quiets: MoveList,
    captures: MoveList,
}

/// Persistent per-game ordering statistics and a fixed-size, four-way transposition table.
pub struct Engine {
    tt: Vec<[Entry; BUCKET_SIZE]>,
    age: u8,
    history: [[[i32; 64]; 64]; 2],
    /// Indexed by (moving piece, to, captured kind).
    capture_history: Vec<i32>,
    /// Indexed by (previous piece, previous to, piece, to); one-ply countermove history.
    continuation: Vec<i32>,
    killers: [[Option<Move>; 2]; MAX_PLY],
    reductions: Vec<[u8; MAX_MOVES]>,
    eval_cache: Vec<u64>,
    pawn_cache: PawnCache,
    frames: Vec<Frame>,
}

impl Engine {
    #[must_use]
    pub fn new(tt_mb: usize) -> Self {
        let capacity = (tt_mb.saturating_mul(1024 * 1024)
            / std::mem::size_of::<[Entry; BUCKET_SIZE]>())
        .max(1);
        let buckets = 1_usize << (usize::BITS - 1 - capacity.leading_zeros());
        let mut reductions = vec![[0; MAX_MOVES]; MAX_PLY];
        for (depth, row) in reductions.iter_mut().enumerate().skip(1) {
            for (moves, reduction) in row.iter_mut().enumerate().skip(1) {
                *reduction = (0.75 + (depth as f64).ln() * (moves as f64).ln() / 2.25) as u8;
            }
        }
        Self {
            tt: vec![[Entry::EMPTY; BUCKET_SIZE]; buckets],
            age: 0,
            history: [[[0; 64]; 64]; 2],
            capture_history: vec![0; CAPTURE_HISTORY_SIZE],
            continuation: vec![0; CONTINUATION_SIZE],
            killers: [[None; 2]; MAX_PLY],
            reductions,
            eval_cache: vec![0; EVAL_CACHE_SIZE],
            pawn_cache: PawnCache::new(),
            frames: (0..MAX_PLY)
                .map(|_| Frame {
                    moves: MoveList::new(),
                    scores: [0; MAX_MOVES],
                    quiets: MoveList::new(),
                    captures: MoveList::new(),
                })
                .collect(),
        }
    }

    pub fn new_game(&mut self) {
        self.tt.fill([Entry::EMPTY; BUCKET_SIZE]);
        self.history = [[[0; 64]; 64]; 2];
        self.capture_history.fill(0);
        self.continuation.fill(0);
        self.killers.fill([None; 2]);
        self.age = 0;
    }

    /// Ages the TT and the ordering statistics before a new search.
    fn prepare(&mut self) {
        self.age = self.age.wrapping_add(1);
        // Retain game history, but age its influence between searches.
        for side in &mut self.history {
            for from in side {
                for value in from {
                    *value /= 2;
                }
            }
        }
        for value in self
            .capture_history
            .iter_mut()
            .chain(&mut self.continuation)
        {
            *value /= 2;
        }
        self.killers.fill([None; 2]);
    }

    /// `history_hashes` contains game positions BEFORE `position`, in chronological order.
    /// Calls `on_iteration` only after a completed iteration; false ends deepening.
    /// The root position must be valid, as required by the board's trusted search API.
    pub fn think(
        &mut self,
        position: &Position,
        history_hashes: &[u64],
        limits: EngineLimits<'_>,
        on_iteration: &mut dyn FnMut(&IterationInfo) -> bool,
    ) -> EngineResult {
        self.prepare();
        let fallback = position.legal_moves_trusted().first().copied();
        let mut result = EngineResult {
            best_move: fallback,
            score_cp: if fallback.is_none() {
                if position.is_check() { -MATE } else { 0 }
            } else {
                static_eval(position)
            },
            depth: 0,
            nodes: 0,
            pv: fallback.into_iter().collect(),
        };
        if fallback.is_none() {
            return result;
        }
        let root_in_check = position.is_check();
        let max_depth = limits.max_depth.unwrap_or((MAX_PLY - 2) as u8);
        let mut search = Search::new(self, limits, history_hashes);
        for depth in 1..=max_depth.min((MAX_PLY - 2) as u8) {
            let score = search.aspirate(position, depth, Some(result.score_cp), root_in_check);
            if search.aborted {
                if result.depth == 0 {
                    if let Some((score, pv)) = search.partial.take() {
                        result.best_move = pv.first().copied().or(fallback);
                        result.score_cp = score;
                        result.pv = pv;
                    }
                }
                break;
            }
            let pv = search.line(0);
            result.best_move = pv.first().copied().or(fallback);
            result.score_cp = score;
            result.depth = depth;
            result.pv = if pv.is_empty() {
                fallback.into_iter().collect()
            } else {
                pv
            };
            let info = IterationInfo {
                depth,
                seldepth: search.seldepth as u8,
                score_cp: score,
                mate_in: mate_in(score),
                nodes: search.nodes,
                pv: result.pv.clone(),
            };
            if !on_iteration(&info) || mate_in(score).is_some() {
                break;
            }
        }
        result.nodes = search.nodes;
        result
    }

    /// MultiPV: the best `count` root moves, each with its own full-strength score and line.
    /// Every depth searches line k with the first k-1 moves of that depth excluded, all under one
    /// shared node budget. An interrupted depth is dropped unless no depth finished yet.
    pub fn think_multi(
        &mut self,
        position: &Position,
        history_hashes: &[u64],
        limits: EngineLimits<'_>,
        count: usize,
    ) -> MultiResult {
        self.prepare();
        let count = count.min(position.legal_moves_trusted().len());
        if count == 0 {
            return MultiResult {
                lines: Vec::new(),
                depth: 0,
                nodes: 0,
            };
        }
        let root_in_check = position.is_check();
        let max_depth = limits.max_depth.unwrap_or((MAX_PLY - 2) as u8);
        let mut search = Search::new(self, limits, history_hashes);
        let mut lines: Vec<RootLine> = Vec::new();
        let mut completed = 0;
        for depth in 1..=max_depth.min((MAX_PLY - 2) as u8) {
            let mut current = Vec::with_capacity(count);
            search.excluded.clear();
            for index in 0..count {
                let guess = lines.get(index).map(|line| line.score_cp);
                let score = search.aspirate(position, depth, guess, root_in_check);
                if search.aborted {
                    break;
                }
                let pv = search.line(0);
                let Some(&mv) = pv.first() else {
                    break;
                };
                search.excluded.push(mv);
                current.push(RootLine {
                    mv,
                    score_cp: score,
                    mate_in: mate_in(score),
                    pv,
                });
            }
            current.sort_by_key(|line| std::cmp::Reverse(line.score_cp));
            if search.aborted {
                if completed == 0 {
                    lines = current;
                }
                break;
            }
            lines = current;
            completed = depth;
            if lines.first().is_some_and(|line| line.mate_in.is_some()) {
                break;
            }
        }
        if lines.is_empty() {
            if let Some((score, pv)) = search.partial.take() {
                if let Some(&mv) = pv.first() {
                    lines.push(RootLine {
                        mv,
                        score_cp: score,
                        mate_in: None,
                        pv,
                    });
                }
            }
        }
        MultiResult {
            lines,
            depth: completed,
            nodes: search.nodes,
        }
    }

    /// Side-to-move static eval, cached by Zobrist key. The eval fits in i16 because it is
    /// clamped inside the mate band; an empty slot never matches a real key's tag and eval.
    fn eval(&mut self, position: &Position) -> i32 {
        let key = position.zobrist_hash();
        let slot = &mut self.eval_cache[key as usize & (EVAL_CACHE_SIZE - 1)];
        if *slot != 0 && (*slot ^ key) >> 16 == 0 {
            return i32::from(*slot as u16 as i16);
        }
        let score = side_relative(position, evaluate_cached(position, &mut self.pawn_cache));
        *slot = (key & !0xFFFF) | u64::from(score as i16 as u16);
        score
    }

    fn probe(&self, key: u64) -> Option<Entry> {
        self.tt[key as usize & (self.tt.len() - 1)]
            .iter()
            .find(|entry| entry.bound != Bound::Empty && entry.key == key)
            .copied()
    }

    fn store(&mut self, mut entry: Entry, ply: usize) {
        entry.score = score_to_tt(entry.score, ply as i32);
        entry.age = self.age;
        let mask = self.tt.len() - 1;
        let bucket = &mut self.tt[entry.key as usize & mask];
        let target = if let Some(index) = bucket
            .iter()
            .position(|old| old.bound != Bound::Empty && old.key == entry.key)
        {
            let old = &bucket[index];
            if old.age == self.age && old.depth > entry.depth && entry.bound != Bound::Exact {
                return;
            }
            index
        } else {
            bucket
                .iter()
                .enumerate()
                .min_by_key(|(_, old)| {
                    if old.bound == Bound::Empty {
                        i32::MIN
                    } else {
                        i32::from(old.depth) - 8 * i32::from(self.age.wrapping_sub(old.age))
                    }
                })
                .map_or(0, |(index, _)| index)
        };
        bucket[target] = entry;
    }

    /// Scores `frames[ply].moves` for ordering into `frames[ply].scores`.
    fn score_moves(
        &mut self,
        position: &Position,
        ply: usize,
        tt_move: Option<Move>,
        prev: Option<usize>,
    ) {
        let frame = &mut self.frames[ply];
        let history = &self.history[color_index(position.side_to_move())];
        let en_passant = position.en_passant_target();
        for (index, &mv) in frame.moves.iter().enumerate() {
            let (from, to) = (square_index(mv.from()), square_index(mv.to()));
            // Generated moves always have a piece on `from`.
            let moving = position.piece_at(mv.from()).map_or(0, piece_index);
            let target = position.piece_at(mv.to());
            let capture = target.is_some()
                || (en_passant == Some(mv.to()) && moving % 6 == kind_index(PieceKind::Pawn));
            let score = if Some(mv) == tt_move {
                2_000_000
            } else if capture || mv.promotion().is_some() {
                let victim = target.map_or(kind_index(PieceKind::Pawn), |p| kind_index(p.kind()));
                let captured = match target {
                    Some(p) => piece_value(p.kind()),
                    None if capture => PAWN_VALUE,
                    None => 0,
                };
                let learned = self.capture_history[(moving * 64 + to) * 6 + victim];
                1_000_000 + 16 * (captured + promotion_gain(mv)) - KIND_VALUES[moving % 6]
                    + learned / 8
            } else if self.killers[ply][0] == Some(mv) {
                900_000
            } else if self.killers[ply][1] == Some(mv) {
                800_000
            } else {
                history[from][to]
                    + prev.map_or(0, |base| self.continuation[base + moving * 64 + to])
            };
            frame.scores[index] = score * 256 + (255 - index as i32);
        }
    }

    /// History malus for the quiets and captures tried at `ply` before the cutoff move.
    fn penalize_tried(&mut self, position: &Position, ply: usize, prev: Option<usize>, malus: i32) {
        let side = color_index(position.side_to_move());
        let frame = &self.frames[ply];
        for &mv in frame.quiets.iter() {
            gravity(
                &mut self.history[side][square_index(mv.from())][square_index(mv.to())],
                malus,
            );
            if let Some(index) = continuation_index(position, prev, mv) {
                gravity(&mut self.continuation[index], malus);
            }
        }
        for &mv in frame.captures.iter() {
            if let Some(index) = capture_index(position, mv) {
                gravity(&mut self.capture_history[index], malus);
            }
        }
    }

    fn update_history(&mut self, side: usize, mv: Move, bonus: i32) {
        gravity(
            &mut self.history[side][square_index(mv.from())][square_index(mv.to())],
            bonus,
        );
    }

    fn update_quiet(&mut self, position: &Position, prev: Option<usize>, mv: Move, bonus: i32) {
        self.update_history(color_index(position.side_to_move()), mv, bonus);
        if let Some(index) = continuation_index(position, prev, mv) {
            gravity(&mut self.continuation[index], bonus);
        }
    }

    fn update_capture(&mut self, position: &Position, mv: Move, bonus: i32) {
        if let Some(index) = capture_index(position, mv) {
            gravity(&mut self.capture_history[index], bonus);
        }
    }
}

struct Search<'engine, 'limits> {
    engine: &'engine mut Engine,
    limits: EngineLimits<'limits>,
    hashes: Vec<u64>,
    null_branch: usize,
    nodes: u64,
    seldepth: usize,
    aborted: bool,
    pv: Vec<[Option<Move>; MAX_PLY]>,
    pv_end: [usize; MAX_PLY],
    partial: Option<(i32, Vec<Move>)>,
    /// Continuation-history row of the move that led to each ply; `None` at the root and after null.
    prev: [Option<usize>; MAX_PLY + 1],
    /// Static eval per ply on the current path; `NO_EVAL` while in check.
    evals: [i32; MAX_PLY + 1],
    /// Root moves already reported by earlier MultiPV lines of this iteration.
    excluded: Vec<Move>,
}

impl<'engine, 'limits> Search<'engine, 'limits> {
    fn new(
        engine: &'engine mut Engine,
        limits: EngineLimits<'limits>,
        history_hashes: &[u64],
    ) -> Self {
        Search {
            engine,
            limits,
            hashes: history_hashes.to_vec(),
            // Null subtrees are hypothetical: never claim game draws or store their bounds.
            null_branch: 0,
            nodes: 0,
            seldepth: 0,
            aborted: false,
            pv: vec![[None; MAX_PLY]; MAX_PLY],
            pv_end: [0; MAX_PLY],
            partial: None,
            prev: [None; MAX_PLY + 1],
            evals: [NO_EVAL; MAX_PLY + 1],
            excluded: Vec::new(),
        }
    }

    /// Searches the root at `depth` with an aspiration window around `guess` (full window when
    /// there is no guess or the depth is shallow), widening until the score lands inside it.
    fn aspirate(
        &mut self,
        position: &Position,
        depth: u8,
        guess: Option<i32>,
        in_check: bool,
    ) -> i32 {
        let mut window = if depth >= 4 && guess.is_some() {
            25
        } else {
            INF
        };
        let guess = guess.unwrap_or(0);
        let mut alpha = (guess - window).max(-INF);
        let mut beta = (guess + window).min(INF);
        loop {
            let score = self.negamax(position, i32::from(depth), 0, alpha, beta, true, in_check);
            if self.aborted || (score > alpha && score < beta) {
                return score;
            }
            window = (window * 2).min(INF);
            if score <= alpha {
                alpha = (score - window).max(-INF);
            } else {
                beta = (score + window).min(INF);
            }
        }
    }

    fn visit(&mut self, ply: usize) -> bool {
        if self.aborted
            || self.limits.nodes.is_some_and(|limit| self.nodes >= limit)
            || (self.nodes & 1023 == 0
                && self
                    .limits
                    .stop
                    .is_some_and(|stop| stop.load(Ordering::Relaxed)))
        {
            self.aborted = true;
            return false;
        }
        self.nodes += 1;
        self.seldepth = self.seldepth.max(ply);
        self.pv_end[ply] = ply;
        true
    }

    fn is_draw(&self, position: &Position, ply: usize) -> bool {
        if position.has_insufficient_material() {
            return true;
        }
        if self.null_branch != 0 {
            return false;
        }
        if position.is_fifty_move_draw() {
            return true;
        }
        let key = position.zobrist_hash();
        // Twofold breaks cycles within search. At the root require an actual threefold.
        let needed = if ply == 0 { 2 } else { 1 };
        self.hashes
            .iter()
            .rev()
            .take(position.halfmove_clock() as usize)
            .filter(|&&previous| previous == key)
            .take(needed)
            .count()
            == needed
    }

    fn line(&self, ply: usize) -> Vec<Move> {
        self.pv[ply][ply..self.pv_end[ply]]
            .iter()
            .flatten()
            .copied()
            .collect()
    }

    fn set_pv(&mut self, ply: usize, mv: Move) {
        self.pv[ply][ply] = Some(mv);
        let end = self.pv_end[ply + 1].max(ply + 1);
        for index in ply + 1..end {
            self.pv[ply][index] = self.pv[ply + 1][index];
        }
        self.pv_end[ply] = end;
    }

    #[allow(clippy::too_many_arguments)]
    fn negamax(
        &mut self,
        position: &Position,
        mut depth: i32,
        ply: usize,
        mut alpha: i32,
        mut beta: i32,
        allow_null: bool,
        in_check: bool,
    ) -> i32 {
        if depth <= 0 {
            return self.quiescence(position, ply, alpha, beta, in_check);
        }
        if !self.visit(ply) {
            return 0;
        }
        if let Some(score) = self.terminal_score(position, ply, in_check) {
            return score;
        }
        alpha = alpha.max(-MATE + ply as i32);
        beta = beta.min(MATE - ply as i32 - 1);
        if alpha >= beta {
            return alpha;
        }
        if in_check {
            depth += 1;
        }
        let original_alpha = alpha;
        let pv_node = beta - alpha > 1;
        let key = position.zobrist_hash();
        let hit = self.engine.probe(key);
        let tt_move = hit.and_then(|entry| entry.best);
        if !pv_node {
            if let Some(entry) = hit {
                if i32::from(entry.depth) >= depth {
                    let score = score_from_tt(entry.score, ply as i32);
                    if entry.bound == Bound::Exact
                        || (entry.bound == Bound::Lower && score >= beta)
                        || (entry.bound == Bound::Upper && score <= alpha)
                    {
                        return score;
                    }
                }
            }
        }
        // Internal iterative reduction: without a hash move the ordering is poor, so search shallower.
        if depth >= 4 && tt_move.is_none() {
            depth -= 1;
        }
        let eval = if in_check {
            0
        } else {
            self.engine.eval(position)
        };
        self.evals[ply] = if in_check { NO_EVAL } else { eval };
        // Improving: the side to move is better off than two plies ago.
        let improving = !in_check && ply >= 2 && eval > self.evals[ply - 2];
        if !pv_node && !in_check && beta.abs() < MATE_BOUND {
            // Reverse futility: even a conservative loss of depth * 85 cp still beats beta.
            let margin = 85 * (depth - i32::from(improving));
            if depth <= 6 && eval - margin >= beta {
                return eval - margin;
            }
            if allow_null
                && depth >= 3
                && eval >= beta
                && position.has_non_pawn_material(position.side_to_move())
            {
                let child = position.after_null_move();
                self.prev[ply + 1] = None;
                self.null_branch += 1;
                let score = -self.negamax(
                    &child,
                    depth - 1 - (3 + depth / 4),
                    ply + 1,
                    -beta,
                    -beta + 1,
                    false,
                    false,
                );
                self.null_branch -= 1;
                if self.aborted {
                    return 0;
                }
                if score >= beta {
                    // A reduced null search cannot establish a forced mate.
                    return score.min(MATE_BOUND - 1);
                }
            }
        }
        let frame = &mut self.engine.frames[ply];
        position.pseudo_legal_moves_into(&mut frame.moves);
        frame.quiets.clear();
        frame.captures.clear();
        let move_count = frame.moves.len();
        self.engine
            .score_moves(position, ply, tt_move, self.prev[ply]);
        let side = color_index(position.side_to_move());
        let mut best = -INF;
        let mut best_move = None;
        // Legal moves that were searched; pruned moves are legal but never counted, and pruning
        // needs a searched move first, so zero here means no legal move exists.
        let mut searched = 0;
        let prev = self.prev[ply];
        let lmp_count = if improving {
            3 + depth * depth
        } else {
            (3 + depth * depth) / 2
        } as usize;
        for index in 0..move_count {
            let mv = self.engine.frames[ply].select(index);
            if ply == 0 && self.excluded.contains(&mv) {
                continue;
            }
            // Pruning is decided before the move is made; an illegal move skipped here would
            // have been skipped anyway, and neither changes the counters pruning reads.
            let quiet = !position.is_capture(mv) && mv.promotion().is_none();
            if searched > 0
                && quiet
                && !in_check
                && !pv_node
                && best > -MATE_BOUND
                && ((depth <= 3 && eval + 100 + 120 * depth <= alpha)
                    || (depth <= 5 && self.engine.frames[ply].quiets.len() >= lmp_count))
                && !position.gives_check(mv)
            {
                // Forward futility and late move pruning only skip non-forcing moves.
                continue;
            }
            if searched > 0
                && depth <= 6
                && ply > 0
                && !in_check
                && best > -MATE_BOUND
                && mv.promotion().is_none()
            {
                // SEE pruning: skip moves that lose too much material on the destination square.
                let threshold = if quiet {
                    -30 * depth * depth
                } else {
                    -100 * depth
                };
                let may_lose = quiet
                    || position
                        .piece_at(mv.from())
                        .is_some_and(|p| piece_value(p.kind()) > captured_value(position, mv));
                if may_lose && see(position, mv) < threshold {
                    continue;
                }
            }
            let Some(child) = position.after_pseudo_move(mv) else {
                continue;
            };
            let gives_check = child.is_check();
            self.prev[ply + 1] = position
                .piece_at(mv.from())
                .map(|p| (piece_index(p) * 64 + square_index(mv.to())) * PIECE_SQUARES);
            self.hashes.push(key);
            let next_depth = depth - 1;
            let mut score;
            if searched == 0 {
                score = -self.negamax(
                    &child,
                    next_depth,
                    ply + 1,
                    -beta,
                    -alpha,
                    true,
                    gives_check,
                );
            } else {
                let mut reduction = 0;
                if depth >= 3
                    && searched >= 3
                    && quiet
                    && !in_check
                    && !gives_check
                    && !self.engine.killers[ply].contains(&Some(mv))
                {
                    reduction = i32::from(
                        self.engine.reductions[depth.min((MAX_PLY - 1) as i32) as usize]
                            [(searched + 1).min(MAX_MOVES - 1)],
                    );
                    reduction -= i32::from(pv_node);
                    reduction -= i32::from(improving);
                    let quiet_history = self.engine.history[side][square_index(mv.from())]
                        [square_index(mv.to())]
                        + continuation_index(position, prev, mv)
                            .map_or(0, |index| self.engine.continuation[index]);
                    reduction -= quiet_history / 16_384;
                    reduction = reduction.clamp(0, (next_depth - 1).max(0));
                }
                score = -self.negamax(
                    &child,
                    next_depth - reduction,
                    ply + 1,
                    -alpha - 1,
                    -alpha,
                    true,
                    gives_check,
                );
                if !self.aborted && reduction > 0 && score > alpha {
                    score = -self.negamax(
                        &child,
                        next_depth,
                        ply + 1,
                        -alpha - 1,
                        -alpha,
                        true,
                        gives_check,
                    );
                }
                if !self.aborted && pv_node && score > alpha && score < beta {
                    score = -self.negamax(
                        &child,
                        next_depth,
                        ply + 1,
                        -beta,
                        -alpha,
                        true,
                        gives_check,
                    );
                }
            }
            self.hashes.pop();
            if self.aborted {
                return 0;
            }
            searched += 1;
            if score > best {
                best = score;
                best_move = Some(mv);
                self.set_pv(ply, mv);
                if ply == 0 {
                    self.partial = Some((score, self.line(0)));
                }
            }
            alpha = alpha.max(score);
            if score >= beta {
                let bonus = (32 * depth * depth).min(2048);
                if quiet {
                    if self.engine.killers[ply][0] != Some(mv) {
                        self.engine.killers[ply][1] = self.engine.killers[ply][0];
                        self.engine.killers[ply][0] = Some(mv);
                    }
                    self.engine.update_quiet(position, prev, mv, bonus);
                } else if position.is_capture(mv) {
                    self.engine.update_capture(position, mv, bonus);
                }
                self.engine.penalize_tried(position, ply, prev, -bonus);
                break;
            }
            if quiet {
                self.engine.frames[ply].quiets.push(mv);
            } else if position.is_capture(mv) {
                self.engine.frames[ply].captures.push(mv);
            }
        }
        if searched == 0 {
            return if in_check { -MATE + ply as i32 } else { 0 };
        }
        self.engine.store(
            Entry {
                key,
                best: best_move,
                score: best,
                depth: depth as i16,
                age: 0,
                bound: if best >= beta {
                    Bound::Lower
                } else if best <= original_alpha {
                    Bound::Upper
                } else {
                    Bound::Exact
                },
            },
            ply,
        );
        best
    }

    /// Draw and depth-limit exits shared by both searches. Checkmate takes precedence over rule
    /// 50 and repetition, so a drawn-looking node in check still needs to know whether it has a
    /// legal move; that costs a move scan only on this rare path.
    fn terminal_score(&self, position: &Position, ply: usize, in_check: bool) -> Option<i32> {
        let drawn = self.is_draw(position, ply);
        if !drawn && ply != MAX_PLY - 1 {
            return None;
        }
        if in_check && !position.has_any_legal_move_trusted() {
            return Some(-MATE + ply as i32);
        }
        Some(if drawn { 0 } else { static_eval(position) })
    }

    fn quiescence(
        &mut self,
        position: &Position,
        ply: usize,
        mut alpha: i32,
        mut beta: i32,
        in_check: bool,
    ) -> i32 {
        if !self.visit(ply) {
            return 0;
        }
        if let Some(score) = self.terminal_score(position, ply, in_check) {
            return score;
        }
        alpha = alpha.max(-MATE + ply as i32);
        beta = beta.min(MATE - ply as i32 - 1);
        if alpha >= beta {
            return alpha;
        }
        let stand_pat = if in_check {
            -INF
        } else {
            self.engine.eval(position)
        };
        let mut best = stand_pat;
        let moves = &mut self.engine.frames[ply].moves;
        if in_check {
            // Every evasion, quiet ones included.
            position.pseudo_legal_moves_into(moves);
        } else {
            if stand_pat >= beta {
                return stand_pat;
            }
            alpha = alpha.max(stand_pat);
            // Captures and queen promotions; stalemate is not detected here.
            position.pseudo_legal_captures_into(moves);
        }
        let move_count = moves.len();
        self.engine.score_moves(position, ply, None, None);
        let key = position.zobrist_hash();
        let mut legal = false;
        for index in 0..move_count {
            let mv = self.engine.frames[ply].select(index);
            // Delta and SEE pruning only happen when not in check, where `legal` is unused,
            // so testing them before legality skips the same moves.
            if !in_check && mv.promotion().is_none() {
                let victim = captured_value(position, mv);
                let attacker = position
                    .piece_at(mv.from())
                    .map_or(0, |p| piece_value(p.kind()));
                if (stand_pat + victim + 200 < alpha
                    || (attacker > victim && see(position, mv) < 0))
                    && !position.gives_check(mv)
                {
                    continue;
                }
            }
            let Some(child) = position.after_pseudo_move(mv) else {
                continue;
            };
            legal = true;
            let gives_check = child.is_check();
            self.hashes.push(key);
            let score = -self.quiescence(&child, ply + 1, -beta, -alpha, gives_check);
            self.hashes.pop();
            if self.aborted {
                return 0;
            }
            if score > best {
                best = score;
            }
            if score > alpha {
                self.set_pv(ply, mv);
                alpha = score;
            }
            if score >= beta {
                break;
            }
        }
        if in_check && !legal {
            return -MATE + ply as i32;
        }
        best
    }
}

fn gravity(value: &mut i32, bonus: i32) {
    let bonus = bonus.clamp(-HISTORY_MAX, HISTORY_MAX);
    *value += bonus - *value * bonus.abs() / HISTORY_MAX;
}

const fn kind_index(kind: PieceKind) -> usize {
    match kind {
        PieceKind::King => 0,
        PieceKind::Queen => 1,
        PieceKind::Rook => 2,
        PieceKind::Bishop => 3,
        PieceKind::Knight => 4,
        PieceKind::Pawn => 5,
    }
}

fn piece_index(piece: Piece) -> usize {
    color_index(piece.color()) * 6 + kind_index(piece.kind())
}

fn continuation_index(position: &Position, prev: Option<usize>, mv: Move) -> Option<usize> {
    let base = prev?;
    let piece = position.piece_at(mv.from())?;
    Some(base + piece_index(piece) * 64 + square_index(mv.to()))
}

/// Capture-history slot; en passant has no piece on the destination and captures a pawn.
fn capture_index(position: &Position, mv: Move) -> Option<usize> {
    let piece = position.piece_at(mv.from())?;
    let victim = position
        .piece_at(mv.to())
        .map_or(kind_index(PieceKind::Pawn), |p| kind_index(p.kind()));
    Some((piece_index(piece) * 64 + square_index(mv.to())) * 6 + victim)
}

impl Frame {
    /// Selection step: moves the first highest-scored move at or after `index` to `index`.
    /// Each key is `score * 256 + (255 - position)`, so the plain maximum is the first best
    /// move and the low byte says where it is.
    fn select(&mut self, index: usize) -> Move {
        let len = self.moves.len();
        let top = self.scores[index..len].iter().copied().max().unwrap_or(0);
        let best = 255 - (top & 0xFF) as usize;
        self.moves.swap(index, best);
        self.scores[best] = (self.scores[index] & !0xFF) | (255 - best as i32);
        self.moves[index]
    }
}

fn static_eval(position: &Position) -> i32 {
    side_relative(position, evaluate_tapered(position))
}

/// White-relative eval to the side to move, kept inside the mate band.
fn side_relative(position: &Position, white: i32) -> i32 {
    let score = white.clamp(-MATE_BOUND + 1, MATE_BOUND - 1);
    if position.side_to_move() == Color::White {
        score
    } else {
        -score
    }
}

fn mate_in(score: i32) -> Option<i32> {
    (score.abs() >= MATE_BOUND).then(|| score.signum() * ((MATE - score.abs() + 1) / 2))
}

fn score_to_tt(score: i32, ply: i32) -> i32 {
    if score >= MATE_BOUND {
        score + ply
    } else if score <= -MATE_BOUND {
        score - ply
    } else {
        score
    }
}

fn score_from_tt(score: i32, ply: i32) -> i32 {
    if score >= MATE_BOUND {
        score - ply
    } else if score <= -MATE_BOUND {
        score + ply
    } else {
        score
    }
}

const fn color_index(side: Color) -> usize {
    match side {
        Color::White => 0,
        Color::Black => 1,
    }
}

fn square_index(square: Square) -> usize {
    square.rank() as usize * 8 + square.file() as usize
}

/// `piece_value` by `kind_index`.
const KIND_VALUES: [i32; 6] = [
    piece_value(PieceKind::King),
    QUEEN_VALUE,
    ROOK_VALUE,
    BISHOP_VALUE,
    KNIGHT_VALUE,
    PAWN_VALUE,
];

const fn piece_value(kind: PieceKind) -> i32 {
    match kind {
        PieceKind::Pawn => PAWN_VALUE,
        PieceKind::Knight => KNIGHT_VALUE,
        PieceKind::Bishop => BISHOP_VALUE,
        PieceKind::Rook => ROOK_VALUE,
        PieceKind::Queen => QUEEN_VALUE,
        PieceKind::King => 20_000,
    }
}

fn captured_value(position: &Position, mv: Move) -> i32 {
    position.piece_at(mv.to()).map_or_else(
        || {
            if position.is_capture(mv) {
                PAWN_VALUE
            } else {
                0
            }
        },
        |p| piece_value(p.kind()),
    )
}

fn promotion_gain(mv: Move) -> i32 {
    match mv.promotion() {
        Some(PromotionPiece::Queen) => QUEEN_VALUE - PAWN_VALUE,
        Some(PromotionPiece::Rook) => ROOK_VALUE - PAWN_VALUE,
        Some(PromotionPiece::Bishop) => BISHOP_VALUE - PAWN_VALUE,
        Some(PromotionPiece::Knight) => KNIGHT_VALUE - PAWN_VALUE,
        None => 0,
    }
}

/// Swap-off material result of capture `mv` for the side to move: both sides keep recapturing
/// on the destination with their cheapest attacker and stop when continuing loses material.
/// Pins are ignored; a king only recaptures when no enemy attacker is left to take it.
fn see(position: &Position, mv: Move) -> i32 {
    const KINDS: [PieceKind; 6] = [
        PieceKind::Pawn,
        PieceKind::Knight,
        PieceKind::Bishop,
        PieceKind::Rook,
        PieceKind::Queen,
        PieceKind::King,
    ];
    let Some(moving) = position.piece_at(mv.from()) else {
        return 0;
    };
    let mut occupied = position.occupied_bitboard() ^ (1 << square_index(mv.from()));
    if moving.kind() == PieceKind::Pawn
        && position.piece_at(mv.to()).is_none()
        && mv.from().file() != mv.to().file()
    {
        occupied ^= 1 << square_index(Square::new(mv.to().file(), mv.from().rank()));
    }
    let mut gain = [0_i32; 32];
    gain[0] = captured_value(position, mv);
    let mut on_square = piece_value(moving.kind());
    let mut side = position.side_to_move().opposite();
    let mut depth = 0;
    while depth + 1 < gain.len() {
        let attackers = position.attackers_to(mv.to(), occupied) & occupied;
        let Some((kind, bit)) = KINDS.iter().find_map(|&kind| {
            let candidates = attackers & position.piece_bitboard(side, kind);
            (candidates != 0).then(|| (kind, candidates & candidates.wrapping_neg()))
        }) else {
            break;
        };
        if kind == PieceKind::King {
            let remaining = position.attackers_to(mv.to(), occupied ^ bit) & (occupied ^ bit);
            let defenders = KINDS.iter().fold(0, |all, &kind| {
                all | position.piece_bitboard(side.opposite(), kind)
            });
            if remaining & defenders != 0 {
                break;
            }
        }
        depth += 1;
        gain[depth] = on_square - gain[depth - 1];
        on_square = piece_value(kind);
        occupied ^= bit;
        side = side.opposite();
    }
    // Every gain[1..=depth] is a capture that was actually found, so all of them fold back.
    while depth > 0 {
        gain[depth - 1] = -i32::max(-gain[depth - 1], gain[depth]);
        depth -= 1;
    }
    gain[0]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn see_of(fen: &str, uci: &str) -> i32 {
        let position = Position::from_fen(fen).unwrap();
        see(&position, Move::from_coordinate(uci).unwrap())
    }

    #[test]
    fn see_counts_the_last_recapture() {
        // Free pawn: Re1xe5, nothing recaptures.
        assert_eq!(
            see_of("1k1r4/1pp4p/p7/4p3/8/P5P1/1PP4P/2K1R3 w - - 0 1", "e1e5"),
            100
        );
        // Queen takes a pawn defended by a pawn: dxe5 wins the queen.
        assert_eq!(see_of("4k3/8/3p4/4p3/8/8/8/4Q1K1 w - - 0 1", "e1e5"), -800);
        // Chessprogramming wiki SEE example: Nxe5 loses knight for pawn.
        assert_eq!(
            see_of(
                "1k1r3q/1ppn3p/p4b2/4p3/8/P2N2P1/1PP1R1BP/2K1Q3 w - - 0 1",
                "d3e5"
            ),
            -220
        );
        // Quiet move into a knight attack, defended by a pawn: Nxb5 axb5 costs 10.
        assert_eq!(see_of("4k3/2n5/8/8/P7/8/8/4KB2 w - - 0 1", "f1b5"), -10);
        // Quiet move into an undefended pawn attack loses the piece.
        assert_eq!(see_of("4k3/8/2p5/8/8/8/8/4KB2 w - - 0 1", "f1b5"), -330);
        // En passant with a single recapture: exd6 cxd6 trades pawns.
        assert_eq!(see_of("4k3/2p5/8/3pP3/8/8/8/4K3 w - d6 0 1", "e5d6"), 0);
    }
}
