//! Explore on the playing engine: what the selected side should play now.
//!
//! The candidates are the engine's MultiPV lines (full-strength search, tapered eval), so every
//! score is the honest value of that move. The aggressive toggle never touches the search: among
//! the sound candidates (within [`EXPLORE_SOUND_MARGIN_CP`] of the best) it puts the most
//! attacking one first.

use chess_board::{Color, File, Move, PieceKind, Position, PositionStatus, Rank, Square};
use chess_eval::{MoveQuality, classify_win_percent_loss, win_percent};

use crate::engine::{Engine, EngineLimits, RootLine};
use crate::{
    BRILLIANT_ALREADY_WINNING, BRILLIANT_STILL_OK, ForcingKind, SearchError, move_hangs_material,
};

/// Soundness margin for the side-oriented Explore lens (centipawns). A candidate is "sound" when
/// its full-window exact score falls no more than this below the best exact-scored candidate in the
/// same pass.
pub const EXPLORE_SOUND_MARGIN_CP: i32 = 50;

/// What the opponent's best reply does with a sound sacrifice's offered material (ADR-0154 Packet C).
/// Lets the board show *whether and how* a sacrifice is justified, not just that one exists. Only
/// produced for sound sacrifice candidates; a sacrifice the soundness gate rejects is never drawn, so
/// "refuted" needs no variant here — the absence of the arrow is the refutation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SacrificeAftermath {
    /// The opponent's best reply recaptures the offered piece, yet the line still holds for `side`:
    /// the sacrifice is sound *when accepted* — real compensation follows in the continuation.
    Accepted,
    /// The opponent's best reply declines the offer (does not recapture the offered piece): the
    /// sacrifice stands as a threat the opponent must sidestep rather than take.
    Defended,
}

/// A scored, classified candidate from the side-oriented Explore lens.
///
/// `exact_score` is from a full-window re-search at the depth reached by the candidate pass, signed
/// from `side` (positive = good for `side`) — a real exact score in both modes, never a shared-alpha
/// bound. `sound` is mode-dependent: on-turn it is true when `exact_score` falls within
/// [`EXPLORE_SOUND_MARGIN_CP`] of the best exact-scored candidate (a move `side` can play without
/// blundering); off-turn `side` is not to move, so it is true when the candidate is within
/// [`EXPLORE_SOUND_MARGIN_CP`] of the *most dangerous* opponent reply (a genuine top threat).
/// `sacrifice` (on-turn only) is true when the move is SEE-negative yet `sound`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SideExploreCandidate {
    pub mv: Move,
    pub kind: ForcingKind,
    pub exact_score: i32,
    pub sound: bool,
    pub sacrifice: bool,
    pub mate_in: Option<u8>,
    /// Aftermath verdict for a sound sacrifice: how the opponent's best reply treats the offer. `None`
    /// for non-sacrifice candidates.
    pub aftermath: Option<SacrificeAftermath>,
    /// The aggressor's follow-up move that justifies an accepted sacrifice (the projected line's third
    /// ply). `None` when this is not a sacrifice or no continuation was projected.
    pub continuation: Option<Move>,
    /// True only for a live, exact-rescored, sound sacrifice with a projected future line that
    /// clears the ADR-0216 non-bad and non-triviality gates.
    pub prospective_brilliant: bool,
}

fn annotate_prospective_brilliance(candidates: &mut [SideExploreCandidate]) {
    let trivial_non_sacrificial_win = candidates.iter().any(|candidate| {
        !candidate.sacrifice && win_percent(candidate.exact_score) >= BRILLIANT_ALREADY_WINNING
    });
    for candidate in candidates {
        let expected_win = win_percent(candidate.exact_score);
        candidate.prospective_brilliant = !trivial_non_sacrificial_win
            && candidate.sound
            && candidate.sacrifice
            && candidate.aftermath.is_some()
            && candidate.continuation.is_some()
            && (BRILLIANT_STILL_OK..BRILLIANT_ALREADY_WINNING).contains(&expected_win);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReplyCandidateRole {
    ObjectivePrimary,
    Alternative,
}

/// A ranked rival reply from the off-turn side Explore pass.
///
/// The `score` is exact only after the bounded independent reply re-score completes. Exactly one
/// reply may be marked [`ReplyCandidateRole::ObjectivePrimary`]; alternatives are never used to
/// project the selected-side plan.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReplyCandidate {
    pub mv: Move,
    pub kind: ForcingKind,
    pub score: i32,
    pub quality: MoveQuality,
    pub sound: bool,
    pub sacrifice: bool,
    pub mate_in: Option<u8>,
    pub hangs_material: bool,
    pub role: ReplyCandidateRole,
}

/// What Explore reports for `side`: on-turn its ranked `candidates`; off-turn the opponent's
/// `reply_candidates` plus `side`'s candidates after the opponent's best reply.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SideExploreReport {
    pub side: Color,
    pub on_turn: bool,
    pub reply_candidates: Vec<ReplyCandidate>,
    pub candidates: Vec<SideExploreCandidate>,
    pub principal_line: Vec<Move>,
    pub mate_detected: bool,
    pub depth: u8,
    pub nodes: u64,
}

/// Candidates shown to the user, and replies shown off-turn.
pub const EXPLORE_LINES: usize = 4;
/// Longest principal line reported (the web layer caps lines at this length).
pub const EXPLORE_LINE_PLIES: usize = crate::MAX_REACTION_LINE_PLIES as usize;
/// Fresh table per call keeps Explore deterministic: the same position gives the same answer.
const EXPLORE_HASH_MB: usize = 8;
/// Plies of a candidate's line played out before measuring the pressure on the enemy king: the
/// move, the reply and the selected side's follow-up.
const ATTACK_HORIZON_PLIES: usize = 3;
/// Attack bonus for a check or a sound sacrifice, in king-zone attacker units.
const FORCING_ATTACK_BONUS: i32 = 3;

const FILES: [File; 8] = [
    File::A,
    File::B,
    File::C,
    File::D,
    File::E,
    File::F,
    File::G,
    File::H,
];
const RANKS: [Rank; 8] = [
    Rank::First,
    Rank::Second,
    Rank::Third,
    Rank::Fourth,
    Rank::Fifth,
    Rank::Sixth,
    Rank::Seventh,
    Rank::Eighth,
];

/// Explore for `side` with the real game history (positions before `position`). On-turn it
/// ranks `side`'s moves; off-turn it ranks the opponent's replies, plays the best one and ranks
/// `side`'s moves after it. `node_budget` caps the whole call.
pub fn side_explore(
    position: &Position,
    history_hashes: &[u64],
    node_budget: u64,
    side: Color,
    aggressive: bool,
) -> Result<SideExploreReport, SearchError> {
    let status = position.status()?;
    let on_turn = position.side_to_move() == side;
    let mut report = SideExploreReport {
        side,
        on_turn,
        reply_candidates: Vec::new(),
        candidates: Vec::new(),
        principal_line: Vec::new(),
        mate_detected: status == PositionStatus::Checkmate,
        depth: 0,
        nodes: 0,
    };
    if status != PositionStatus::Ongoing {
        return Ok(report);
    }
    let mut engine = Engine::new(EXPLORE_HASH_MB);
    if on_turn {
        on_turn_report(
            &mut engine,
            position,
            history_hashes,
            node_budget,
            aggressive,
            &mut report,
        )?;
        return Ok(report);
    }

    // Off-turn: a third of the budget ranks the opponent's replies, the rest plans after the best.
    let reply_budget = (node_budget / 3).max(1);
    let replies = multi_pv(&mut engine, position, history_hashes, reply_budget);
    report.nodes = replies.nodes;
    report.depth = replies.depth;
    report.reply_candidates = reply_candidates(position, &replies.lines);
    let Some(reply) = replies.lines.first().map(|line| line.mv) else {
        return Ok(report);
    };
    let child = position.after_known_legal_move(reply)?;
    let child_status = child.status()?;
    if child_status != PositionStatus::Ongoing {
        report.mate_detected = child_status == PositionStatus::Checkmate;
        return Ok(report);
    }
    let mut child_history = history_hashes.to_vec();
    child_history.push(position.zobrist_hash());
    let used = report.nodes;
    on_turn_report(
        &mut engine,
        &child,
        &child_history,
        node_budget.saturating_sub(used).max(1),
        aggressive,
        &mut report,
    )?;
    report.nodes += used;
    Ok(report)
}

/// The move the aggressive Play personality commits to: Explore's top aggressive candidate for
/// the side to move. `None` only when the game is over.
pub fn aggressive_best_move(
    position: &Position,
    history_hashes: &[u64],
    node_budget: u64,
) -> Result<SideExploreReport, SearchError> {
    side_explore(
        position,
        history_hashes,
        node_budget,
        position.side_to_move(),
        true,
    )
}

struct Lines {
    lines: Vec<RootLine>,
    depth: u8,
    nodes: u64,
}

fn multi_pv(engine: &mut Engine, position: &Position, history: &[u64], budget: u64) -> Lines {
    engine.new_game();
    let result = engine.think_multi(
        position,
        history,
        EngineLimits {
            max_depth: None,
            nodes: Some(budget),
            stop: None,
        },
        EXPLORE_LINES,
    );
    Lines {
        lines: result.lines,
        depth: result.depth,
        nodes: result.nodes,
    }
}

/// Fills candidates, principal line, depth and nodes for the side to move in `position`.
fn on_turn_report(
    engine: &mut Engine,
    position: &Position,
    history_hashes: &[u64],
    budget: u64,
    aggressive: bool,
    report: &mut SideExploreReport,
) -> Result<(), SearchError> {
    let lines = multi_pv(engine, position, history_hashes, budget);
    report.depth = lines.depth;
    report.nodes = lines.nodes;
    let Some(best) = lines.lines.first().map(|line| line.score_cp) else {
        return Ok(());
    };
    let mut ranked = Vec::with_capacity(lines.lines.len());
    for line in &lines.lines {
        let candidate = candidate(position, line, best)?;
        let attack = if aggressive && candidate.sound {
            attack_score(position, line, &candidate)?
        } else {
            i32::MIN
        };
        ranked.push((candidate, attack, line));
    }
    // Neutral keeps the engine's order. Aggressive moves the most attacking sound move first; the
    // sort is stable, so equal attacks keep the better score first and unsound moves stay last.
    if aggressive {
        ranked.sort_by_key(|(_, attack, _)| std::cmp::Reverse(*attack));
    }
    report.candidates = ranked.iter().map(|(candidate, _, _)| *candidate).collect();
    annotate_prospective_brilliance(&mut report.candidates);
    if let Some((top, _, line)) = ranked.first() {
        report.principal_line = line.pv.iter().take(EXPLORE_LINE_PLIES).copied().collect();
        report.mate_detected = top.mate_in.is_some();
    }
    Ok(())
}

fn candidate(
    position: &Position,
    line: &RootLine,
    best: i32,
) -> Result<SideExploreCandidate, SearchError> {
    let mv = line.mv;
    let sound = line.score_cp >= best.saturating_sub(EXPLORE_SOUND_MARGIN_CP);
    let sacrifice = sound && move_hangs_material(position, mv);
    let mate_in = winning_mate(line);
    let (aftermath, continuation) = if sacrifice {
        let accepted = line.pv.get(1).is_some_and(|reply| reply.to() == mv.to());
        (
            Some(if accepted {
                SacrificeAftermath::Accepted
            } else {
                SacrificeAftermath::Defended
            }),
            line.pv.get(2).copied(),
        )
    } else {
        (None, None)
    };
    Ok(SideExploreCandidate {
        mv,
        kind: forcing_kind(position, mv, mate_in)?,
        exact_score: line.score_cp,
        sound,
        sacrifice,
        mate_in,
        aftermath,
        continuation,
        prospective_brilliant: false,
    })
}

fn reply_candidates(position: &Position, lines: &[RootLine]) -> Vec<ReplyCandidate> {
    let Some(best) = lines.first().map(|line| line.score_cp) else {
        return Vec::new();
    };
    lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| {
            let mate_in = winning_mate(line);
            let sound = line.score_cp >= best.saturating_sub(EXPLORE_SOUND_MARGIN_CP);
            let hangs_material = move_hangs_material(position, line.mv);
            Some(ReplyCandidate {
                mv: line.mv,
                kind: forcing_kind(position, line.mv, mate_in).ok()?,
                score: line.score_cp,
                quality: classify_win_percent_loss(best, line.score_cp),
                sound,
                sacrifice: sound && hangs_material,
                mate_in,
                hangs_material,
                role: if index == 0 {
                    ReplyCandidateRole::ObjectivePrimary
                } else {
                    ReplyCandidateRole::Alternative
                },
            })
        })
        .collect()
}

/// Full moves to a mate the mover delivers; `None` for no mate or a mate against the mover.
fn winning_mate(line: &RootLine) -> Option<u8> {
    line.mate_in
        .filter(|&moves| moves > 0)
        .map(|moves| u8::try_from(moves).unwrap_or(u8::MAX))
}

fn forcing_kind(
    position: &Position,
    mv: Move,
    mate_in: Option<u8>,
) -> Result<ForcingKind, SearchError> {
    Ok(if mate_in.is_some() {
        ForcingKind::Mate
    } else if position.after_known_legal_move(mv)?.is_check() {
        ForcingKind::Check
    } else if position.is_capture(mv) {
        ForcingKind::Capture
    } else {
        ForcingKind::Defense
    })
}

/// How hard a candidate goes after the enemy king: the selected side's attackers on the enemy
/// king zone once the line's first [`ATTACK_HORIZON_PLIES`] plies are played, plus a bonus for a
/// check or a sound sacrifice. Measuring after the follow-up lets a quiet move that builds an
/// attack count, not only immediate checks.
fn attack_score(
    position: &Position,
    line: &RootLine,
    candidate: &SideExploreCandidate,
) -> Result<i32, SearchError> {
    let side = position.side_to_move();
    let mut current = position.clone();
    for &mv in line.pv.iter().take(ATTACK_HORIZON_PLIES) {
        current = current.after_known_legal_move(mv)?;
    }
    let forcing =
        matches!(candidate.kind, ForcingKind::Mate | ForcingKind::Check) || candidate.sacrifice;
    Ok(king_zone_attackers(&current, side) + i32::from(forcing) * FORCING_ATTACK_BONUS)
}

/// `side`'s non-king attackers on the enemy king's square and its neighbours, counted per square.
fn king_zone_attackers(position: &Position, side: Color) -> i32 {
    let king = position.piece_bitboard(side.opposite(), PieceKind::King);
    if king == 0 {
        return 0;
    }
    let king_index = king.trailing_zeros() as i32;
    let (king_file, king_rank) = (king_index % 8, king_index / 8);
    let attackers = [
        PieceKind::Pawn,
        PieceKind::Knight,
        PieceKind::Bishop,
        PieceKind::Rook,
        PieceKind::Queen,
    ]
    .into_iter()
    .fold(0, |bits, kind| bits | position.piece_bitboard(side, kind));
    let occupied = position.occupied_bitboard();
    let mut count = 0;
    for rank in (king_rank - 1).max(0)..=(king_rank + 1).min(7) {
        for file in (king_file - 1).max(0)..=(king_file + 1).min(7) {
            let square = Square::new(FILES[file as usize], RANKS[rank as usize]);
            count += (position.attackers_to(square, occupied) & attackers).count_ones() as i32;
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prospective_brilliant_requires_every_contract_gate() {
        let candidate = |coordinate: &str,
                         score: i32,
                         sound: bool,
                         sacrifice: bool,
                         future: bool| SideExploreCandidate {
            mv: Move::from_coordinate(coordinate).expect("move parses"),
            kind: ForcingKind::Capture,
            exact_score: score,
            sound,
            sacrifice,
            mate_in: None,
            aftermath: future.then_some(SacrificeAftermath::Accepted),
            continuation: future.then(|| Move::from_coordinate("g1f3").expect("move parses")),
            prospective_brilliant: false,
        };
        let mut candidates = vec![
            candidate("e2e4", 100, true, true, true),
            candidate("d2d4", -1, true, true, true),
            candidate("c2c4", 1_000, true, true, true),
            candidate("b2b4", 100, true, true, false),
            candidate("g2g4", 100, false, true, true),
            candidate("h2h4", 100, true, false, true),
        ];

        annotate_prospective_brilliance(&mut candidates);

        assert!(candidates[0].prospective_brilliant);
        assert!(
            candidates[1..]
                .iter()
                .all(|candidate| !candidate.prospective_brilliant)
        );

        candidates.push(candidate("a2a4", 1_000, true, false, true));
        annotate_prospective_brilliance(&mut candidates);
        assert!(
            candidates
                .iter()
                .all(|candidate| !candidate.prospective_brilliant)
        );
    }

    const BUDGET: u64 = 60_000;

    fn fen(text: &str) -> Position {
        Position::from_fen(text).expect("fixture FEN parses")
    }

    fn explore(position: &Position, side: Color, aggressive: bool) -> SideExploreReport {
        side_explore(position, &[], BUDGET, side, aggressive).expect("explore runs")
    }

    fn moves(report: &SideExploreReport) -> Vec<Move> {
        report.candidates.iter().map(|c| c.mv).collect()
    }

    #[test]
    fn on_turn_is_deterministic_within_budget_and_legal() {
        let position = fen("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2");
        let first = explore(&position, Color::White, false);
        assert_eq!(first, explore(&position, Color::White, false));
        assert!(first.on_turn && first.nodes <= BUDGET && first.depth >= 6);
        assert_eq!(first.candidates.len(), EXPLORE_LINES);
        assert_eq!(first.principal_line.first(), Some(&first.candidates[0].mv));
        for (index, candidate) in first.candidates.iter().enumerate() {
            position.after_legal_move(candidate.mv).expect("legal");
            assert!(index == 0 || candidate.exact_score <= first.candidates[index - 1].exact_score);
        }
    }

    #[test]
    fn aggressive_only_reorders_sound_candidates() {
        // Middlegame with both kings castled: several sound moves, some aimed at the king.
        let position = fen("r1bq1rk1/pppn1ppp/4p3/3pP3/1b1P4/2NB1N2/PPP2PPP/R2QK2R w KQ - 0 8");
        let neutral = explore(&position, Color::White, false);
        let aggressive = explore(&position, Color::White, true);
        let mut left = moves(&neutral);
        let mut right = moves(&aggressive);
        left.sort_by_key(|mv| mv.to_coordinate());
        right.sort_by_key(|mv| mv.to_coordinate());
        assert_eq!(
            left, right,
            "aggressive must not change the searched candidates"
        );
        let best = neutral.candidates[0].exact_score;
        let top = aggressive.candidates[0];
        assert!(top.sound && top.exact_score >= best - EXPLORE_SOUND_MARGIN_CP);
        assert_eq!(aggressive.principal_line.first(), Some(&top.mv));
    }

    #[test]
    fn off_turn_ranks_replies_then_plans_after_the_primary() {
        let position = Position::startpos();
        let report = explore(&position, Color::Black, false);
        assert!(!report.on_turn && report.nodes <= BUDGET);
        let primary: Vec<_> = report
            .reply_candidates
            .iter()
            .filter(|reply| reply.role == ReplyCandidateRole::ObjectivePrimary)
            .collect();
        assert_eq!(primary.len(), 1);
        let child = position
            .after_legal_move(primary[0].mv)
            .expect("legal reply");
        assert!(!report.candidates.is_empty());
        for candidate in &report.candidates {
            child
                .after_legal_move(candidate.mv)
                .expect("legal after the primary reply");
        }
    }

    #[test]
    fn mate_in_one_is_first_and_flagged() {
        let position = fen("6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1");
        for aggressive in [false, true] {
            let report = explore(&position, Color::White, aggressive);
            let top = report.candidates[0];
            assert_eq!(top.mv.to_coordinate(), "a1a8");
            assert_eq!((top.kind, top.mate_in), (ForcingKind::Mate, Some(1)));
            assert!(report.mate_detected);
        }
    }
}
