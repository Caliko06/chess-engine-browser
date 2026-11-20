pub mod tapered;

use chess_board::{Color, File, Piece, PieceKind, Position, Rank, Square};

pub const PAWN_VALUE: i32 = 100;
pub const KNIGHT_VALUE: i32 = 320;
pub const BISHOP_VALUE: i32 = 330;
pub const ROOK_VALUE: i32 = 500;
pub const QUEEN_VALUE: i32 = 900;

const BISHOP_PAIR_BONUS: i32 = 25;
const DOUBLED_PAWN_PENALTY: i32 = 12;
const ISOLATED_PAWN_PENALTY: i32 = 10;
const MOBILITY_BONUS_PER_TARGET: i32 = 2;
/// Bonus for a passed pawn, indexed by how far it has advanced from its home rank (0..=6; a pawn on
/// the seventh rank — one step from promotion — is index 6). The curve ramps steeply near promotion:
/// a passer about to queen is a concrete, near-decisive threat, not a marginal structural edge. The
/// previous flat curve (topping at 70cp on the seventh rank) let the search treat an about-to-promote
/// enemy pawn as barely worse than a distant one, so it would chase attacks and ignore the promotion
/// (a measured ~56cp swing between a fourth-rank and seventh-rank passer, when it should be several
/// hundred). Index 7 is unreachable — a pawn reaching the eighth rank promotes and is scored as the
/// promoted piece — and stays 0.
const PASSED_PAWN_BONUS_BY_ADVANCE: [i32; 8] = [0, 0, 15, 30, 60, 115, 210, 0];

/// Initiative bonus for the side to move. Small enough never to distort material, large enough to
/// break ties toward keeping the move and the attack alive.
const TEMPO_BONUS: i32 = 12;

/// Danger weight each attacking piece kind contributes per enemy king-zone square it attacks.
/// A piece that bears on several zone squares contributes once to each square.
const fn king_attack_weight(kind: PieceKind) -> i32 {
    match kind {
        PieceKind::Queen => 5,
        PieceKind::Rook => 3,
        PieceKind::Bishop | PieceKind::Knight => 2,
        PieceKind::Pawn => 1,
        PieceKind::King => 0,
    }
}

/// Centipawns of pressure per king-danger unit. The danger units sum the [`king_attack_weight`] of
/// every enemy piece for each king-zone square it attacks, so piling pieces onto the squares around
/// the enemy king is rewarded — that is what steers the engine toward an attack. Tuned high enough
/// to clearly outweigh quiet shuffling while the cap keeps it short of a sacrificed piece.
const KING_ATTACK_SCALE: i32 = 12;

/// King-attack pressure is capped below a minor piece, so a real attack is worth a meaningful slice
/// of pressure while never on its own outweighing a sacrificed piece — the search has to confirm
/// the sacrifice. There is deliberately no game-phase fade: an attack with no attackers already
/// scores zero, and keeping attacks valued into the endgame is what finds the late mating nets.
const KING_ATTACK_PENALTY_CAP: i32 = 300;

/// Rook activity: a rook on a file with no pawns at all (open) or only enemy pawns (semi-open) eyes
/// the enemy position and supports an attack.
const ROOK_OPEN_FILE_BONUS: i32 = 22;
const ROOK_SEMI_OPEN_FILE_BONUS: i32 = 11;

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

const PAWN_TABLE: [i32; 64] = [
    0, 0, 0, 0, 0, 0, 0, 0, //
    0, 0, 0, 4, 4, 0, 0, 0, //
    2, 2, 4, 8, 8, 4, 2, 2, //
    4, 4, 8, 14, 14, 8, 4, 4, //
    8, 8, 12, 18, 18, 12, 8, 8, //
    12, 12, 16, 24, 24, 16, 12, 12, //
    18, 18, 22, 30, 30, 22, 18, 18, //
    0, 0, 0, 0, 0, 0, 0, 0,
];

const KNIGHT_TABLE: [i32; 64] = [
    -35, -20, -15, -10, -10, -15, -20, -35, //
    -20, -8, -2, 0, 0, -2, -8, -20, //
    -15, -2, 8, 12, 12, 8, -2, -15, //
    -10, 0, 12, 18, 18, 12, 0, -10, //
    -10, 0, 12, 18, 18, 12, 0, -10, //
    -15, -2, 8, 12, 12, 8, -2, -15, //
    -20, -8, -2, 0, 0, -2, -8, -20, //
    -35, -20, -15, -10, -10, -15, -20, -35,
];

const BISHOP_TABLE: [i32; 64] = [
    -12, -6, -6, -6, -6, -6, -6, -12, //
    -6, 4, 2, 2, 2, 2, 4, -6, //
    -6, 4, 8, 8, 8, 8, 4, -6, //
    -6, 2, 8, 10, 10, 8, 2, -6, //
    -6, 2, 8, 10, 10, 8, 2, -6, //
    -6, 4, 8, 8, 8, 8, 4, -6, //
    -6, 4, 2, 2, 2, 2, 4, -6, //
    -12, -6, -6, -6, -6, -6, -6, -12,
];

const ROOK_TABLE: [i32; 64] = [
    0, 0, 2, 4, 4, 2, 0, 0, //
    -2, 0, 2, 4, 4, 2, 0, -2, //
    -2, 0, 2, 4, 4, 2, 0, -2, //
    -2, 0, 2, 4, 4, 2, 0, -2, //
    -2, 0, 2, 4, 4, 2, 0, -2, //
    -2, 0, 2, 4, 4, 2, 0, -2, //
    8, 10, 12, 14, 14, 12, 10, 8, //
    0, 0, 2, 4, 4, 2, 0, 0,
];

const QUEEN_TABLE: [i32; 64] = [
    -8, -4, -4, -2, -2, -4, -4, -8, //
    -4, 0, 2, 2, 2, 2, 0, -4, //
    -4, 2, 4, 4, 4, 4, 2, -4, //
    -2, 2, 4, 6, 6, 4, 2, -2, //
    -2, 2, 4, 6, 6, 4, 2, -2, //
    -4, 2, 4, 4, 4, 4, 2, -4, //
    -4, 0, 2, 2, 2, 2, 0, -4, //
    -8, -4, -4, -2, -2, -4, -4, -8,
];

#[must_use]
pub fn material_score(position: &Position) -> i32 {
    let mut score = 0;
    for rank in RANKS {
        for file in FILES {
            let Some(piece) = position.piece_at(Square::new(file, rank)) else {
                continue;
            };
            let value = piece_value(piece.kind());
            score += match piece.color() {
                Color::White => value,
                Color::Black => -value,
            };
        }
    }
    score
}

#[must_use]
pub fn evaluate(position: &Position) -> i32 {
    let zone = build_king_zone_map(position);
    evaluate_from_zone(position, &zone)
}

fn evaluate_from_zone(position: &Position, zone: &KingZoneMap) -> i32 {
    let mut score = 0;
    let mut white_bishops = 0_u8;
    let mut black_bishops = 0_u8;
    let mut white_rooks_by_file = [0_u8; 8];
    let mut black_rooks_by_file = [0_u8; 8];
    let mut pawns = PawnStructure::default();

    for (rank_index, rank) in RANKS.iter().copied().enumerate() {
        for (file_index, file) in FILES.iter().copied().enumerate() {
            let Some(piece) = position.piece_at(Square::new(file, rank)) else {
                continue;
            };
            let value = piece_value(piece.kind())
                + piece_square_bonus(piece.kind(), piece.color(), file_index, rank_index);
            score += signed(piece.color(), value);

            match (piece.color(), piece.kind()) {
                (Color::White, PieceKind::Bishop) => white_bishops += 1,
                (Color::Black, PieceKind::Bishop) => black_bishops += 1,
                (Color::White, PieceKind::Rook) => white_rooks_by_file[file_index] += 1,
                (Color::Black, PieceKind::Rook) => black_rooks_by_file[file_index] += 1,
                (Color::White, PieceKind::Pawn) => {
                    pawns.white[file_index][rank_index] = true;
                    pawns.white_by_file[file_index] += 1;
                }
                (Color::Black, PieceKind::Pawn) => {
                    pawns.black[file_index][rank_index] = true;
                    pawns.black_by_file[file_index] += 1;
                }
                _ => {}
            }
        }
    }

    if white_bishops >= 2 {
        score += BISHOP_PAIR_BONUS;
    }
    if black_bishops >= 2 {
        score -= BISHOP_PAIR_BONUS;
    }

    score
        + pawn_structure_score(&pawns)
        + mobility_score(position)
        + king_safety_score_from_zone(zone)
        + rook_file_score(&white_rooks_by_file, &black_rooks_by_file, &pawns)
        + signed(position.side_to_move(), TEMPO_BONUS)
}

/// Move-quality classification for a candidate move, mirroring the categories chess players see in
/// analysis. The first two are conditional tags the search layer assigns from board context (a sound
/// sacrifice, or a uniquely critical move); the rest are the centipawn-loss bands.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MoveQuality {
    Brilliant,
    Great,
    Best,
    Excellent,
    Good,
    Inaccuracy,
    Mistake,
    Blunder,
}

/// Lichess win-probability model: maps a centipawn score (from the perspective of the side to move)
/// to a win percentage in `0.0..=100.0`. This is what turns raw centipawns into a human "winning
/// chances" scale, so a move's quality reflects how much it changes the likely outcome rather than a
/// flat centipawn delta — the same idea behind chess.com's expected-points classification.
#[must_use]
pub fn win_percent(centipawns: i32) -> f64 {
    let cp = f64::from(centipawns);
    50.0 + 50.0 * (2.0 / (1.0 + (-0.003_682_08 * cp).exp()) - 1.0)
}

/// Base move-quality band from the win percentage a move concedes against the best available move,
/// both scores taken from the side-to-move perspective. The thresholds are the expected-points
/// bands (2/5/10/20 percentage points) chess engines use. This never returns the conditional
/// [`MoveQuality::Brilliant`] or [`MoveQuality::Great`] tags — those depend on board context the
/// caller supplies (a sacrifice, or a uniquely critical move).
#[must_use]
pub fn classify_win_percent_loss(best_cp: i32, candidate_cp: i32) -> MoveQuality {
    let loss = (win_percent(best_cp) - win_percent(candidate_cp)).max(0.0);
    if loss <= 0.0 {
        MoveQuality::Best
    } else if loss <= 2.0 {
        MoveQuality::Excellent
    } else if loss <= 5.0 {
        MoveQuality::Good
    } else if loss <= 10.0 {
        MoveQuality::Inaccuracy
    } else if loss <= 20.0 {
        MoveQuality::Mistake
    } else {
        MoveQuality::Blunder
    }
}

/// White-relative rook activity bonus across all files.
fn rook_file_score(
    white_rooks_by_file: &[u8; 8],
    black_rooks_by_file: &[u8; 8],
    pawns: &PawnStructure,
) -> i32 {
    let mut score = 0;
    for file_index in 0..8 {
        let white_pawns = pawns.white_by_file[file_index] > 0;
        let black_pawns = pawns.black_by_file[file_index] > 0;
        let white_rooks = i32::from(white_rooks_by_file[file_index]);
        let black_rooks = i32::from(black_rooks_by_file[file_index]);
        if white_rooks > 0 {
            score += white_rooks * rook_file_bonus(white_pawns, black_pawns);
        }
        if black_rooks > 0 {
            score -= black_rooks * rook_file_bonus(black_pawns, white_pawns);
        }
    }
    score
}

/// A rook's file bonus from its own perspective: open (no pawns at all) beats semi-open (only enemy
/// pawns); a file with the rook's own pawns is blocked and earns nothing.
const fn rook_file_bonus(own_pawns: bool, enemy_pawns: bool) -> i32 {
    if own_pawns {
        0
    } else if enemy_pawns {
        ROOK_SEMI_OPEN_FILE_BONUS
    } else {
        ROOK_OPEN_FILE_BONUS
    }
}

const fn piece_value(kind: PieceKind) -> i32 {
    match kind {
        PieceKind::King => 0,
        PieceKind::Queen => QUEEN_VALUE,
        PieceKind::Rook => ROOK_VALUE,
        PieceKind::Bishop => BISHOP_VALUE,
        PieceKind::Knight => KNIGHT_VALUE,
        PieceKind::Pawn => PAWN_VALUE,
    }
}

const fn signed(color: Color, value: i32) -> i32 {
    match color {
        Color::White => value,
        Color::Black => -value,
    }
}

fn piece_square_bonus(kind: PieceKind, color: Color, file_index: usize, rank_index: usize) -> i32 {
    let table_rank = match color {
        Color::White => rank_index,
        Color::Black => 7 - rank_index,
    };
    let index = (table_rank * 8) + file_index;
    match kind {
        PieceKind::King => 0,
        PieceKind::Queen => QUEEN_TABLE[index],
        PieceKind::Rook => ROOK_TABLE[index],
        PieceKind::Bishop => BISHOP_TABLE[index],
        PieceKind::Knight => KNIGHT_TABLE[index],
        PieceKind::Pawn => PAWN_TABLE[index],
    }
}

#[derive(Default)]
struct PawnStructure {
    white: [[bool; 8]; 8],
    black: [[bool; 8]; 8],
    white_by_file: [u8; 8],
    black_by_file: [u8; 8],
}

fn pawn_structure_score(pawns: &PawnStructure) -> i32 {
    let mut score = 0;
    for file_index in 0..8 {
        score += signed_pawn_file_score(Color::White, file_index, pawns);
        score += signed_pawn_file_score(Color::Black, file_index, pawns);
    }
    score
}

fn signed_pawn_file_score(color: Color, file_index: usize, pawns: &PawnStructure) -> i32 {
    let pawn_count = match color {
        Color::White => pawns.white_by_file[file_index],
        Color::Black => pawns.black_by_file[file_index],
    };
    if pawn_count == 0 {
        return 0;
    }

    let mut score = 0;
    if pawn_count > 1 {
        score -= i32::from(pawn_count - 1) * DOUBLED_PAWN_PENALTY;
    }
    if is_isolated_pawn_file(color, file_index, pawns) {
        score -= i32::from(pawn_count) * ISOLATED_PAWN_PENALTY;
    }

    for rank_index in 0..8 {
        if has_pawn(color, file_index, rank_index, pawns)
            && is_passed_pawn(color, file_index, rank_index, pawns)
        {
            let advance = match color {
                Color::White => rank_index,
                Color::Black => 7 - rank_index,
            };
            score += PASSED_PAWN_BONUS_BY_ADVANCE[advance];
        }
    }

    signed(color, score)
}

fn is_isolated_pawn_file(color: Color, file_index: usize, pawns: &PawnStructure) -> bool {
    let left = file_index
        .checked_sub(1)
        .is_some_and(|index| pawn_count(color, index, pawns) > 0);
    let right = file_index + 1 < 8 && pawn_count(color, file_index + 1, pawns) > 0;
    !left && !right
}

fn is_passed_pawn(
    color: Color,
    file_index: usize,
    rank_index: usize,
    pawns: &PawnStructure,
) -> bool {
    let first_file = file_index.saturating_sub(1);
    let last_file = (file_index + 1).min(7);

    (first_file..=last_file).all(|enemy_file| {
        (0..8).all(|enemy_rank| {
            !has_pawn(opposite(color), enemy_file, enemy_rank, pawns)
                || !is_ahead_of_pawn(color, rank_index, enemy_rank)
        })
    })
}

const fn opposite(color: Color) -> Color {
    match color {
        Color::White => Color::Black,
        Color::Black => Color::White,
    }
}

fn mobility_score(position: &Position) -> i32 {
    let mut score = 0;
    for rank in RANKS {
        for file in FILES {
            let square = Square::new(file, rank);
            let Some(piece) = position.piece_at(square) else {
                continue;
            };
            let targets = mobility_targets(position, square, piece.color(), piece.kind());
            score += signed(
                piece.color(),
                i32::from(targets) * MOBILITY_BONUS_PER_TARGET,
            );
        }
    }
    score
}

fn mobility_targets(position: &Position, square: Square, color: Color, kind: PieceKind) -> u8 {
    match kind {
        PieceKind::King | PieceKind::Pawn => 0,
        PieceKind::Knight => step_targets(
            position,
            square,
            color,
            &[
                (1, 2),
                (2, 1),
                (2, -1),
                (1, -2),
                (-1, -2),
                (-2, -1),
                (-2, 1),
                (-1, 2),
            ],
        ),
        PieceKind::Bishop => ray_targets(
            position,
            square,
            color,
            &[(1, 1), (1, -1), (-1, -1), (-1, 1)],
        ),
        PieceKind::Rook => {
            ray_targets(position, square, color, &[(1, 0), (0, -1), (-1, 0), (0, 1)])
        }
        PieceKind::Queen => ray_targets(
            position,
            square,
            color,
            &[
                (1, 0),
                (1, 1),
                (0, 1),
                (-1, 1),
                (-1, 0),
                (-1, -1),
                (0, -1),
                (1, -1),
            ],
        ),
    }
}

fn step_targets(position: &Position, square: Square, color: Color, deltas: &[(i8, i8)]) -> u8 {
    let (file, rank) = square_coordinates(square);
    deltas
        .iter()
        .filter_map(|(file_delta, rank_delta)| {
            square_from_coordinates(file + file_delta, rank + rank_delta)
        })
        .filter(|target| {
            position
                .piece_at(*target)
                .is_none_or(|piece| piece.color() != color)
        })
        .count()
        .try_into()
        .expect("board target count fits in u8")
}

fn ray_targets(position: &Position, square: Square, color: Color, directions: &[(i8, i8)]) -> u8 {
    let (start_file, start_rank) = square_coordinates(square);
    let mut targets = 0_u8;
    for (file_delta, rank_delta) in directions {
        let mut file = start_file;
        let mut rank = start_rank;
        loop {
            file += file_delta;
            rank += rank_delta;
            let Some(target) = square_from_coordinates(file, rank) else {
                break;
            };
            match position.piece_at(target) {
                Some(piece) if piece.color() == color => break,
                Some(_) => {
                    targets += 1;
                    break;
                }
                None => targets += 1,
            }
        }
    }
    targets
}

#[cfg(test)]
fn king_safety_score(position: &Position) -> i32 {
    let zone = build_king_zone_map(position);
    king_safety_score_from_zone(&zone)
}

/// Summed king-attack weight of all `attacker_color` pieces attacking `target`. Test-only brute-force
/// reference for [`build_king_zone_map`].
#[cfg(test)]
fn zone_square_danger(position: &Position, attacker_color: Color, target: Square) -> i32 {
    let mut danger = 0;
    for rank in RANKS {
        for file in FILES {
            let square = Square::new(file, rank);
            let Some(piece) = position.piece_at(square) else {
                continue;
            };
            if piece.color() == attacker_color
                && piece_attacks_square(position, square, piece, target)
            {
                danger += king_attack_weight(piece.kind());
            }
        }
    }
    danger
}

#[cfg(test)]
fn piece_attacks_square(
    position: &Position,
    attacker_square: Square,
    attacker: Piece,
    target_square: Square,
) -> bool {
    let (from_file, from_rank) = square_coordinates(attacker_square);
    let (to_file, to_rank) = square_coordinates(target_square);
    let file_delta = to_file - from_file;
    let rank_delta = to_rank - from_rank;

    match attacker.kind() {
        PieceKind::King => file_delta.abs().max(rank_delta.abs()) == 1,
        PieceKind::Queen => {
            attacks_like_bishop(file_delta, rank_delta)
                .is_some_and(|step| path_is_clear(position, attacker_square, target_square, step))
                || attacks_like_rook(file_delta, rank_delta).is_some_and(|step| {
                    path_is_clear(position, attacker_square, target_square, step)
                })
        }
        PieceKind::Rook => attacks_like_rook(file_delta, rank_delta)
            .is_some_and(|step| path_is_clear(position, attacker_square, target_square, step)),
        PieceKind::Bishop => attacks_like_bishop(file_delta, rank_delta)
            .is_some_and(|step| path_is_clear(position, attacker_square, target_square, step)),
        PieceKind::Knight => {
            matches!((file_delta.abs(), rank_delta.abs()), (1, 2) | (2, 1))
        }
        PieceKind::Pawn => match attacker.color() {
            Color::White => rank_delta == 1 && file_delta.abs() == 1,
            Color::Black => rank_delta == -1 && file_delta.abs() == 1,
        },
    }
}

#[cfg(test)]
fn attacks_like_bishop(file_delta: i8, rank_delta: i8) -> Option<(i8, i8)> {
    (file_delta.abs() == rank_delta.abs() && file_delta != 0)
        .then_some((file_delta.signum(), rank_delta.signum()))
}

#[cfg(test)]
fn attacks_like_rook(file_delta: i8, rank_delta: i8) -> Option<(i8, i8)> {
    ((file_delta == 0) ^ (rank_delta == 0)).then_some((file_delta.signum(), rank_delta.signum()))
}

#[cfg(test)]
fn path_is_clear(
    position: &Position,
    attacker_square: Square,
    target_square: Square,
    step: (i8, i8),
) -> bool {
    let (mut file, mut rank) = square_coordinates(attacker_square);
    let (target_file, target_rank) = square_coordinates(target_square);
    loop {
        file += step.0;
        rank += step.1;
        if file == target_file && rank == target_rank {
            return true;
        }
        let Some(square) = square_from_coordinates(file, rank) else {
            return false;
        };
        if position.piece_at(square).is_some() {
            return false;
        }
    }
}

/// Pre-computed attack weights for one color's king zone, built once per eval call.
/// `attack[i]` = total [`king_attack_weight`] of enemy pieces attacking zone square `i`.
/// `targets[..len]` = the zone squares (the king square and its neighbours, ≤ 9), in ascending
/// [`square_bit`] order; `zone` = the same squares as a bitboard (empty, with `len` 0, when the
/// color has no king).
struct KingZoneEntry {
    attack: [i32; 9],
    targets: [Square; 9],
    len: usize,
    zone: u64,
}

impl KingZoneEntry {
    /// The zone of `king`: its square and the (up to 8) neighbours, with all weights zero.
    fn new(king: Option<Square>) -> Self {
        let filler = Square::new(FILES[0], RANKS[0]);
        let mut entry = Self {
            attack: [0; 9],
            targets: [filler; 9],
            len: 0,
            zone: 0,
        };
        if let Some(ks) = king {
            let (kf, kr) = square_coordinates(ks);
            for fd in -1_i8..=1 {
                for rd in -1_i8..=1 {
                    if let Some(target) = square_from_coordinates(kf + fd, kr + rd) {
                        entry.targets[entry.len] = target;
                        entry.len += 1;
                        entry.zone |= 1 << square_bit(target);
                    }
                }
            }
        }
        entry
    }

    /// Fold one enemy piece into the zone of the `color` king, given the squares it `attacks`: it
    /// adds its [`king_attack_weight`] to every zone square it attacks.
    fn add_piece(&mut self, color: Color, piece: Piece, attacks: u64) {
        if piece.color() == color {
            return;
        }
        let mut hits = attacks & self.zone;
        while hits != 0 {
            let bit = hits.trailing_zeros();
            hits &= hits - 1;
            // `targets` is in ascending bit order, so a square's slot is its rank among zone bits.
            let slot = (self.zone & ((1_u64 << bit) - 1)).count_ones() as usize;
            self.attack[slot] += king_attack_weight(piece.kind());
        }
    }
}

/// Pre-computed king-zone data for both colors.
/// `white` = zone of White's king (enemy = Black pieces).
/// `black` = zone of Black's king (enemy = White pieces).
struct KingZoneMap {
    white: KingZoneEntry,
    black: KingZoneEntry,
}

/// Build a [`KingZoneMap`] in one board pass: collect the pieces, the occupancy and both kings, then
/// compute each piece's attacked squares once and intersect them with the (at most 9) squares of each
/// king zone.
fn build_king_zone_map(position: &Position) -> KingZoneMap {
    let mut pieces: [Option<(Square, Piece)>; 64] = [None; 64];
    let mut count = 0;
    let mut occupied = 0_u64;
    let mut white_king = None;
    let mut black_king = None;
    for rank in RANKS {
        for file in FILES {
            let square = Square::new(file, rank);
            let Some(piece) = position.piece_at(square) else {
                continue;
            };
            if piece.kind() == PieceKind::King {
                match piece.color() {
                    Color::White => white_king = white_king.or(Some(square)),
                    Color::Black => black_king = black_king.or(Some(square)),
                }
            }
            occupied |= 1 << square_bit(square);
            pieces[count] = Some((square, piece));
            count += 1;
        }
    }
    let mut zone = KingZoneMap {
        white: KingZoneEntry::new(white_king),
        black: KingZoneEntry::new(black_king),
    };
    for (square, piece) in pieces[..count].iter().flatten().copied() {
        let attacks = piece_attack_mask(square, piece, occupied);
        zone.white.add_piece(Color::White, piece, attacks);
        zone.black.add_piece(Color::Black, piece, attacks);
    }
    zone
}

fn zone_map_entry(zone: &KingZoneMap, color: Color) -> &KingZoneEntry {
    match color {
        Color::White => &zone.white,
        Color::Black => &zone.black,
    }
}

fn king_safety_score_from_zone(zone: &KingZoneMap) -> i32 {
    let mut score = 0;
    for color in [Color::White, Color::Black] {
        let entry = zone_map_entry(zone, color);
        let danger: i32 = entry.attack[..entry.len].iter().sum();
        let penalty = (danger * KING_ATTACK_SCALE).min(KING_ATTACK_PENALTY_CAP);
        score -= signed(color, penalty);
    }
    score
}

/// Bit of `square` in a bitboard: `file * 8 + rank`, so ascending bits run file by file, matching the
/// order of [`KingZoneEntry::targets`].
fn square_bit(square: Square) -> u32 {
    let (file, rank) = square_coordinates(square);
    (file * 8 + rank).unsigned_abs().into()
}

const KNIGHT_STEPS: [(i8, i8); 8] = [
    (1, 2),
    (2, 1),
    (2, -1),
    (1, -2),
    (-1, -2),
    (-2, -1),
    (-2, 1),
    (-1, 2),
];
const KING_STEPS: [(i8, i8); 8] = [
    (1, 0),
    (1, 1),
    (0, 1),
    (-1, 1),
    (-1, 0),
    (-1, -1),
    (0, -1),
    (1, -1),
];
const ROOK_RAYS: [(i8, i8); 4] = [(1, 0), (0, 1), (-1, 0), (0, -1)];
const BISHOP_RAYS: [(i8, i8); 4] = [(1, 1), (-1, 1), (-1, -1), (1, -1)];

/// Per-square attack masks for the leapers, indexed by [`square_bit`]; pawn masks by color
/// (`[White, Black]`).
const KNIGHT_ATTACKS: [u64; 64] = leaper_masks(&KNIGHT_STEPS);
const KING_ATTACKS: [u64; 64] = leaper_masks(&KING_STEPS);
const PAWN_ATTACKS: [[u64; 64]; 2] = [
    leaper_masks(&[(-1, 1), (1, 1)]),
    leaper_masks(&[(-1, -1), (1, -1)]),
];

const fn leaper_masks(steps: &[(i8, i8)]) -> [u64; 64] {
    let mut masks = [0_u64; 64];
    let mut bit = 0;
    while bit < 64 {
        let (file, rank) = ((bit / 8) as i8, (bit % 8) as i8);
        let mut i = 0;
        while i < steps.len() {
            let (f, r) = (file + steps[i].0, rank + steps[i].1);
            if f >= 0 && f < 8 && r >= 0 && r < 8 {
                masks[bit] |= 1 << (f * 8 + r);
            }
            i += 1;
        }
        bit += 1;
    }
    masks
}

/// Squares reached from `square` along `rays`, each ray up to and including its first occupied square.
fn slider_mask(square: Square, occupied: u64, rays: &[(i8, i8)]) -> u64 {
    let (file, rank) = square_coordinates(square);
    let mut mask = 0;
    for &(df, dr) in rays {
        let (mut f, mut r) = (file + df, rank + dr);
        while (0..8).contains(&f) && (0..8).contains(&r) {
            let bit = 1_u64 << (f * 8 + r);
            mask |= bit;
            if occupied & bit != 0 {
                break;
            }
            f += df;
            r += dr;
        }
    }
    mask
}

/// Every square `piece` on `square` attacks, geometrically (own pieces and pins ignored), given the
/// board `occupied` bitboard. The bitboard form of [`piece_attacks_square`].
fn piece_attack_mask(square: Square, piece: Piece, occupied: u64) -> u64 {
    let bit = square_bit(square) as usize;
    match piece.kind() {
        PieceKind::King => KING_ATTACKS[bit],
        PieceKind::Knight => KNIGHT_ATTACKS[bit],
        PieceKind::Pawn => PAWN_ATTACKS[usize::from(piece.color() == Color::Black)][bit],
        PieceKind::Rook => slider_mask(square, occupied, &ROOK_RAYS),
        PieceKind::Bishop => slider_mask(square, occupied, &BISHOP_RAYS),
        PieceKind::Queen => {
            slider_mask(square, occupied, &ROOK_RAYS) | slider_mask(square, occupied, &BISHOP_RAYS)
        }
    }
}

fn square_coordinates(square: Square) -> (i8, i8) {
    (file_index(square.file()), rank_index(square.rank()))
}

fn square_from_coordinates(file: i8, rank: i8) -> Option<Square> {
    let file = FILES.get(usize::try_from(file).ok()?).copied()?;
    let rank = RANKS.get(usize::try_from(rank).ok()?).copied()?;
    Some(Square::new(file, rank))
}

const fn file_index(file: File) -> i8 {
    match file {
        File::A => 0,
        File::B => 1,
        File::C => 2,
        File::D => 3,
        File::E => 4,
        File::F => 5,
        File::G => 6,
        File::H => 7,
    }
}

const fn rank_index(rank: Rank) -> i8 {
    match rank {
        Rank::First => 0,
        Rank::Second => 1,
        Rank::Third => 2,
        Rank::Fourth => 3,
        Rank::Fifth => 4,
        Rank::Sixth => 5,
        Rank::Seventh => 6,
        Rank::Eighth => 7,
    }
}

const fn is_ahead_of_pawn(color: Color, pawn_rank: usize, enemy_rank: usize) -> bool {
    match color {
        Color::White => enemy_rank > pawn_rank,
        Color::Black => enemy_rank < pawn_rank,
    }
}

const fn has_pawn(
    color: Color,
    file_index: usize,
    rank_index: usize,
    pawns: &PawnStructure,
) -> bool {
    match color {
        Color::White => pawns.white[file_index][rank_index],
        Color::Black => pawns.black[file_index][rank_index],
    }
}

const fn pawn_count(color: Color, file_index: usize, pawns: &PawnStructure) -> u8 {
    match color {
        Color::White => pawns.white_by_file[file_index],
        Color::Black => pawns.black_by_file[file_index],
    }
}

#[cfg(test)]
mod tests {
    use chess_board::{Color, File, Position, Rank, Square};

    use super::{
        MoveQuality, PawnStructure, build_king_zone_map, classify_win_percent_loss, evaluate,
        is_passed_pawn, king_safety_score, opposite, win_percent, zone_map_entry,
        zone_square_danger,
    };

    #[test]
    fn win_percent_is_centered_and_symmetric() {
        assert!((win_percent(0) - 50.0).abs() < 1e-9, "an even score is 50%");
        for cp in [50, 150, 300, 900] {
            let sum = win_percent(cp) + win_percent(-cp);
            assert!((sum - 100.0).abs() < 1e-9, "win% must be symmetric at {cp}");
        }
        assert!(
            win_percent(100) > win_percent(0) && win_percent(0) > win_percent(-100),
            "win% must increase with the score"
        );
    }

    #[test]
    fn quality_bands_follow_the_win_percent_loss() {
        // Same score as the best move is Best; larger win% gaps walk down the bands.
        assert_eq!(classify_win_percent_loss(40, 40), MoveQuality::Best);
        assert_eq!(classify_win_percent_loss(0, -50), MoveQuality::Good);
        assert_eq!(classify_win_percent_loss(0, -150), MoveQuality::Mistake);
        assert_eq!(classify_win_percent_loss(300, -300), MoveQuality::Blunder);
        // The base classifier never invents the conditional tags.
        for candidate in [-1000, -200, -10, 0, 200] {
            let quality = classify_win_percent_loss(0, candidate);
            assert!(
                !matches!(quality, MoveQuality::Brilliant | MoveQuality::Great),
                "base classifier must not return conditional tags"
            );
        }
    }

    #[test]
    fn pawn_attacks_count_in_neutral_king_safety() {
        let quiet =
            Position::from_fen("6k1/5p1p/8/8/8/8/8/4K3 w - - 0 1").expect("test FEN parses");
        let pawn_contact =
            Position::from_fen("6k1/5p1p/6P1/8/8/8/8/4K3 w - - 0 1").expect("test FEN parses");

        assert_eq!(
            king_safety_score(&quiet),
            0,
            "without attackers, the isolated king-safety term is quiet"
        );
        assert!(
            king_safety_score(&pawn_contact) > 0,
            "a white pawn attacking f7/h7 around the black king must register king danger"
        );
        assert_eq!(
            zone_square_danger(
                &pawn_contact,
                Color::White,
                Square::new(File::F, Rank::Seventh),
            ),
            1,
            "white pawns attack diagonally upward in the eval attack model"
        );
        assert_eq!(
            zone_square_danger(
                &pawn_contact,
                Color::White,
                Square::new(File::G, Rank::Seventh),
            ),
            0,
            "pawns must not attack straight ahead"
        );
    }

    #[test]
    fn black_pawn_attacks_count_in_neutral_king_safety() {
        let pawn_contact =
            Position::from_fen("4k3/8/8/8/8/6p1/5P1P/6K1 b - - 0 1").expect("test FEN parses");

        assert!(
            king_safety_score(&pawn_contact) < 0,
            "a black pawn attacking f2/h2 around the white king must register king danger"
        );
        assert_eq!(
            zone_square_danger(
                &pawn_contact,
                Color::Black,
                Square::new(File::H, Rank::Second),
            ),
            1,
            "black pawns attack diagonally downward in the eval attack model"
        );
    }

    /// Assert the mask-built zone map equals the per-square brute force for one position.
    fn assert_zone_map_matches_brute_force(position: &Position) {
        let fen = position.to_fen();
        let zone = build_king_zone_map(position);
        for color in [Color::White, Color::Black] {
            let entry = zone_map_entry(&zone, color);
            for i in 0..entry.len {
                assert_eq!(
                    entry.attack[i],
                    zone_square_danger(position, opposite(color), entry.targets[i]),
                    "{fen} attack {color:?} #{i}"
                );
            }
        }
    }

    #[test]
    fn one_pass_zone_map_matches_the_per_square_brute_force() {
        // Breadth-first walk of the legal-move tree from several start positions (deduplicated by
        // FEN): opening, kiwipete, endgames, a pin and promotions.
        let mut compared = 0_usize;
        for (fen, max_positions) in [
            (
                "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
                6_000,
            ),
            (
                "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1P/PPPBBPpP/R3K2R w KQkq - 0 1",
                9_000,
            ),
            ("6k1/5p1p/8/6nQ/8/8/8/4K1R1 w - - 0 1", 4_000),
            ("8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", 6_000),
            ("4k3/P6P/8/8/8/8/p6p/4K3 w - - 0 1", 4_000),
        ] {
            let mut seen = std::collections::HashSet::new();
            let mut frontier = vec![Position::from_fen(fen).expect("test FEN parses")];
            seen.insert(fen.to_owned());
            let mut walked = 0;
            while walked < max_positions && !frontier.is_empty() {
                let mut next = Vec::new();
                for position in &frontier {
                    assert_zone_map_matches_brute_force(position);
                    walked += 1;
                    for mv in position.legal_moves_trusted() {
                        let child = position
                            .after_known_legal_move(mv)
                            .expect("generated move is legal");
                        if seen.insert(child.to_fen()) {
                            next.push(child);
                        }
                    }
                }
                frontier = next;
            }
            compared += walked;
        }
        assert!(compared >= 25_000, "only {compared} positions compared");
    }

    fn pawn_structure(pawns: &[(Color, usize, usize)]) -> PawnStructure {
        let mut structure = PawnStructure::default();
        for (color, file_index, rank_index) in pawns {
            match color {
                Color::White => {
                    structure.white[*file_index][*rank_index] = true;
                    structure.white_by_file[*file_index] += 1;
                }
                Color::Black => {
                    structure.black[*file_index][*rank_index] = true;
                    structure.black_by_file[*file_index] += 1;
                }
            }
        }
        structure
    }

    #[test]
    fn advanced_passed_pawn_is_scored_as_a_real_threat() {
        // Same material (White up a rook); the only difference is how far Black's passer has advanced.
        // A pawn one step from queening (a2) must cut into White's advantage far more than a distant
        // one (a4). With the old flat curve the swing was only ~56cp, so the search treated an
        // about-to-promote pawn as barely worse than a far one and would ignore it in advanced
        // positions. The steep curve makes the imminent promotion a real, felt threat.
        let far = evaluate(
            &Position::from_fen("4k3/8/8/8/p7/8/8/4K2R w K - 0 1").expect("test FEN parses"),
        );
        let near = evaluate(
            &Position::from_fen("4k3/8/8/8/8/8/p7/4K2R w K - 0 1").expect("test FEN parses"),
        );
        assert!(
            far - near >= 100,
            "an about-to-promote passer must swing the eval far more than a distant one \
             (far {far}, near {near}, swing {})",
            far - near
        );
    }

    #[test]
    fn passed_pawn_ignores_adjacent_same_rank_enemy_pawn() {
        let white_same_rank = pawn_structure(&[(Color::White, 4, 3), (Color::Black, 3, 3)]);
        let black_same_rank = pawn_structure(&[(Color::Black, 4, 4), (Color::White, 3, 4)]);

        assert!(is_passed_pawn(Color::White, 4, 3, &white_same_rank));
        assert!(is_passed_pawn(Color::Black, 4, 4, &black_same_rank));
    }

    #[test]
    fn passed_pawn_rejects_enemy_pawn_ahead_on_same_or_adjacent_file() {
        let white_same_file = pawn_structure(&[(Color::White, 4, 3), (Color::Black, 4, 5)]);
        let white_adjacent_file = pawn_structure(&[(Color::White, 4, 3), (Color::Black, 3, 4)]);
        let black_same_file = pawn_structure(&[(Color::Black, 4, 4), (Color::White, 4, 2)]);
        let black_adjacent_file = pawn_structure(&[(Color::Black, 4, 4), (Color::White, 3, 3)]);

        assert!(!is_passed_pawn(Color::White, 4, 3, &white_same_file));
        assert!(!is_passed_pawn(Color::White, 4, 3, &white_adjacent_file));
        assert!(!is_passed_pawn(Color::Black, 4, 4, &black_same_file));
        assert!(!is_passed_pawn(Color::Black, 4, 4, &black_adjacent_file));
    }

    #[test]
    fn passed_pawn_ignores_enemy_pawn_behind() {
        let white_behind = pawn_structure(&[(Color::White, 4, 3), (Color::Black, 3, 2)]);
        let black_behind = pawn_structure(&[(Color::Black, 4, 4), (Color::White, 3, 5)]);

        assert!(is_passed_pawn(Color::White, 4, 3, &white_behind));
        assert!(is_passed_pawn(Color::Black, 4, 4, &black_behind));
    }
}
