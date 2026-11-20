//! Facts behind the plain-language recommendation sentence of the Explore screen.
//!
//! The bridge only reports verifiable board facts about the first candidate and its principal line;
//! the TypeScript formatter turns them into Spanish or English text. Everything here is static
//! (no search): attack facts come from the search crate's static exchange evaluation (SEE), which
//! already resolves attackers, defenders and x-rays without a second move generator.

use chess_board::{Color, File, Move, Piece, PieceKind, Position, PositionStatus, Rank, Square};
use chess_eval::{BISHOP_VALUE, KNIGHT_VALUE, PAWN_VALUE, QUEEN_VALUE, ROOK_VALUE};
use chess_search::static_exchange_eval;

use super::{push_array, push_bool_field, push_i32_field, push_json_string, push_string_field};

const MAX_THREATENED: usize = 3;
const MAX_NEW_THREATS: usize = 2;

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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExplanationSquareDto {
    pub square: String,
    pub piece: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExplanationMoveDto {
    pub mv: String,
    pub piece: &'static str,
    pub captured: Option<&'static str>,
    pub promotion: Option<&'static str>,
    pub castle: Option<&'static str>,
    pub check: bool,
    pub mate: bool,
    pub threats: Vec<ExplanationSquareDto>,
    pub saves_threatened: bool,
    pub hangs: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SideExplanationDto {
    pub in_check: bool,
    pub threatened: Vec<ExplanationSquareDto>,
    pub best: ExplanationMoveDto,
    pub line_material_cp: i32,
}

/// Builds the explanation facts for `first_move` played by the side to move of `position`.
/// Returns `None` when the move does not parse or is illegal.
pub(crate) fn explain_first_candidate(
    position: &Position,
    first_move: &str,
    principal_line: &[String],
) -> Option<SideExplanationDto> {
    let side = position.side_to_move();
    let mv = Move::from_coordinate(first_move).ok()?;
    let child = position.after_legal_move(mv).ok()?;
    let moving = position.piece_at(mv.from())?;

    let before = en_prise(position, side);
    let after = en_prise(&child, side);
    let opponent_before: Vec<Square> = en_prise(position, side.opposite())
        .into_iter()
        .map(|(square, _)| square)
        .collect();
    let threats = en_prise(&child, side.opposite())
        .into_iter()
        .filter(|(square, _)| !opponent_before.contains(square))
        .take(MAX_NEW_THREATS)
        .map(square_dto)
        .collect();

    let captured = if position.is_capture(mv) {
        // En passant leaves the destination empty, so the victim is a pawn there.
        Some(
            position
                .piece_at(mv.to())
                .map_or(PieceKind::Pawn, Piece::kind),
        )
    } else {
        None
    };
    let hangs = child.piece_at(mv.to()).is_some_and(|piece| {
        piece.kind() != PieceKind::King
            && static_exchange_eval(&child, mv.to(), side.opposite()) > 0
    });

    Some(SideExplanationDto {
        in_check: position.is_check(),
        threatened: before
            .iter()
            .copied()
            .take(MAX_THREATENED)
            .map(square_dto)
            .collect(),
        best: ExplanationMoveDto {
            mv: first_move.to_string(),
            piece: piece_name(moving.kind()),
            captured: captured.map(piece_name),
            promotion: promotion_name(mv),
            castle: castle_side(moving.kind(), mv),
            check: child.is_check(),
            mate: child.status_trusted() == PositionStatus::Checkmate,
            threats,
            saves_threatened: after.len() < before.len(),
            hangs,
        },
        line_material_cp: line_material_delta(position, principal_line),
    })
}

/// Pieces of `color` (never the king) that are "en prise": the enemy wins material by capturing
/// them, i.e. static exchange evaluation on their square is positive (attacked and undefended, or
/// attacked by a cheaper piece). Most valuable first.
fn en_prise(position: &Position, color: Color) -> Vec<(Square, PieceKind)> {
    let mut found = Vec::new();
    for rank in RANKS {
        for file in FILES {
            let square = Square::new(file, rank);
            let Some(piece) = position.piece_at(square) else {
                continue;
            };
            if piece.color() == color
                && piece.kind() != PieceKind::King
                && static_exchange_eval(position, square, color.opposite()) > 0
            {
                found.push((square, piece.kind()));
            }
        }
    }
    found.sort_by_key(|(_, kind)| std::cmp::Reverse(value(*kind)));
    found
}

fn castle_side(kind: PieceKind, mv: Move) -> Option<&'static str> {
    if kind != PieceKind::King {
        return None;
    }
    let from = i16::from(mv.from().to_algebraic().as_bytes()[0]);
    let to = i16::from(mv.to().to_algebraic().as_bytes()[0]);
    match to - from {
        2 => Some("king"),
        -2 => Some("queen"),
        _ => None,
    }
}

/// Material (P=100 N=320 B=330 R=500 Q=900) for the side to move minus the opponent, at the end
/// of the principal line minus the same at its start. Stops at the first illegal move.
fn line_material_delta(position: &Position, line: &[String]) -> i32 {
    let side = position.side_to_move();
    let start = material_balance(position, side);
    let mut current = position.clone();
    for text in line {
        let Some(next) = Move::from_coordinate(text)
            .ok()
            .and_then(|mv| current.after_legal_move(mv).ok())
        else {
            break;
        };
        current = next;
    }
    material_balance(&current, side) - start
}

fn material_balance(position: &Position, side: Color) -> i32 {
    let mut total = 0;
    for rank in RANKS {
        for file in FILES {
            if let Some(piece) = position.piece_at(Square::new(file, rank)) {
                let sign = if piece.color() == side { 1 } else { -1 };
                total += sign * value(piece.kind());
            }
        }
    }
    total
}

const fn value(kind: PieceKind) -> i32 {
    match kind {
        PieceKind::Pawn => PAWN_VALUE,
        PieceKind::Knight => KNIGHT_VALUE,
        PieceKind::Bishop => BISHOP_VALUE,
        PieceKind::Rook => ROOK_VALUE,
        PieceKind::Queen => QUEEN_VALUE,
        PieceKind::King => 0,
    }
}

fn square_dto((square, kind): (Square, PieceKind)) -> ExplanationSquareDto {
    ExplanationSquareDto {
        square: square.to_algebraic(),
        piece: piece_name(kind),
    }
}

const fn piece_name(kind: PieceKind) -> &'static str {
    match kind {
        PieceKind::Pawn => "pawn",
        PieceKind::Knight => "knight",
        PieceKind::Bishop => "bishop",
        PieceKind::Rook => "rook",
        PieceKind::Queen => "queen",
        PieceKind::King => "king",
    }
}

fn promotion_name(mv: Move) -> Option<&'static str> {
    mv.promotion()?;
    Some(match mv.to_coordinate().as_bytes()[4] {
        b'r' => "rook",
        b'b' => "bishop",
        b'n' => "knight",
        _ => "queen",
    })
}

pub(crate) fn push_explanation_json(output: &mut String, explanation: &SideExplanationDto) {
    output.push_str(r#"{"inCheck":"#);
    output.push_str(if explanation.in_check {
        "true"
    } else {
        "false"
    });
    output.push_str(r#","threatened":["#);
    push_array(output, &explanation.threatened, push_square_json);
    output.push_str(r#"],"best":"#);
    push_move_json(output, &explanation.best);
    push_i32_field(output, "lineMaterialCp", explanation.line_material_cp);
    output.push('}');
}

fn push_move_json(output: &mut String, best: &ExplanationMoveDto) {
    output.push('{');
    push_string_field(output, "move", &best.mv, false);
    push_string_field(output, "piece", best.piece, true);
    push_optional(output, "captured", best.captured);
    push_optional(output, "promotion", best.promotion);
    push_optional(output, "castle", best.castle);
    push_bool_field(output, "check", best.check);
    push_bool_field(output, "mate", best.mate);
    output.push_str(r#","threats":["#);
    push_array(output, &best.threats, push_square_json);
    output.push(']');
    push_bool_field(output, "savesThreatened", best.saves_threatened);
    push_bool_field(output, "hangs", best.hangs);
    output.push('}');
}

fn push_optional(output: &mut String, name: &str, value: Option<&str>) {
    output.push(',');
    push_json_string(output, name);
    output.push(':');
    match value {
        Some(text) => push_json_string(output, text),
        None => output.push_str("null"),
    }
}

fn push_square_json(output: &mut String, entry: &ExplanationSquareDto) {
    output.push('{');
    push_string_field(output, "square", &entry.square, false);
    push_string_field(output, "piece", entry.piece, true);
    output.push('}');
}

#[cfg(test)]
mod tests {
    use super::{SideExplanationDto, explain_first_candidate, push_explanation_json};
    use chess_board::Position;

    fn explain(fen: &str, mv: &str, line: &[&str]) -> SideExplanationDto {
        let position = Position::from_fen(fen).expect("test FEN should parse");
        let line: Vec<String> = line.iter().map(ToString::to_string).collect();
        explain_first_candidate(&position, mv, &line).expect("test move should be legal")
    }

    #[test]
    fn capture_reports_victim_and_line_gain() {
        let facts = explain("4k3/8/8/4p3/8/5N2/8/4K3 w - - 0 1", "f3e5", &["f3e5"]);
        assert_eq!(facts.best.piece, "knight");
        assert_eq!(facts.best.captured, Some("pawn"));
        assert!(!facts.best.hangs);
        assert!(!facts.in_check);
        assert_eq!(facts.line_material_cp, 100);
    }

    #[test]
    fn quiet_move_reports_new_threat_only() {
        let facts = explain("4k3/8/r7/8/8/1N6/8/4K3 w - - 0 1", "b3c5", &["b3c5"]);
        assert_eq!(facts.best.captured, None);
        assert_eq!(facts.best.threats.len(), 1);
        assert_eq!(facts.best.threats[0].square, "a6");
        assert_eq!(facts.best.threats[0].piece, "rook");
        assert_eq!(facts.line_material_cp, 0);
    }

    #[test]
    fn moving_an_attacked_queen_saves_it() {
        let facts = explain("3rk3/8/8/8/8/8/8/3QK3 w - - 0 1", "d1a4", &[]);
        assert_eq!(facts.threatened.len(), 1);
        assert_eq!(facts.threatened[0].square, "d1");
        assert_eq!(facts.threatened[0].piece, "queen");
        assert!(facts.best.saves_threatened);
        assert!(!facts.best.hangs);
        assert!(facts.best.check);
    }

    #[test]
    fn en_passant_counts_as_pawn_capture() {
        let facts = explain("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1", "e5d6", &["e5d6"]);
        assert_eq!(facts.best.captured, Some("pawn"));
        assert_eq!(facts.line_material_cp, 100);
    }

    #[test]
    fn promotion_castle_and_hanging_piece_are_flagged() {
        let promo = explain("4k3/P7/8/8/8/8/8/4K3 w - - 0 1", "a7a8q", &[]);
        assert_eq!(promo.best.promotion, Some("queen"));
        assert!(promo.best.check);

        let castle = explain("4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1", "e1c1", &[]);
        assert_eq!(castle.best.castle, Some("queen"));

        let hang = explain("4k3/8/8/4p3/8/8/8/3QK3 w - - 0 1", "d1d4", &[]);
        assert!(hang.best.hangs);
    }

    #[test]
    fn json_uses_camel_case_and_null_for_absent_facts() {
        let facts = explain("4k3/8/8/4p3/8/5N2/8/4K3 w - - 0 1", "f3e5", &["f3e5"]);
        let mut json = String::new();
        push_explanation_json(&mut json, &facts);
        assert!(json.starts_with(
            r#"{"inCheck":false,"threatened":[],"best":{"move":"f3e5","piece":"knight","captured":"pawn","promotion":null,"castle":null,"check":false,"mate":false,"threats":["#
        ));
        assert!(json.ends_with(r#""savesThreatened":false,"hangs":false},"lineMaterialCp":100}"#));
    }
}
