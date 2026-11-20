use core::fmt;

use crate::{
    LegalMoveError, Move, Piece, PieceKind, Position, PositionStatus, PromotionPiece, is_in_check,
};

#[non_exhaustive]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SanError {
    Empty,
    InvalidMove,
    AmbiguousMove,
    LegalMove(LegalMoveError),
}

impl fmt::Display for SanError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("SAN token must not be empty"),
            Self::InvalidMove => formatter.write_str("SAN token does not match a legal move"),
            Self::AmbiguousMove => formatter.write_str("SAN token matches multiple legal moves"),
            Self::LegalMove(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for SanError {}

impl From<LegalMoveError> for SanError {
    fn from(error: LegalMoveError) -> Self {
        Self::LegalMove(error)
    }
}

impl Position {
    pub fn move_to_san(&self, mv: Move) -> Result<String, SanError> {
        let legal_moves = self.legal_moves()?;
        if !legal_moves.contains(&mv) {
            return Err(SanError::InvalidMove);
        }

        let moving_piece = self.piece_at(mv.from()).ok_or(SanError::InvalidMove)?;
        let mut san = String::with_capacity(8);

        if is_castle(moving_piece, mv) {
            if mv.to().file().index() > mv.from().file().index() {
                san.push_str("O-O");
            } else {
                san.push_str("O-O-O");
            }
        } else {
            if let Some(letter) = piece_letter(moving_piece.kind()) {
                san.push(letter);
                append_disambiguation(self, &legal_moves, mv, moving_piece, &mut san);
            }

            if is_capture(self, mv, moving_piece) {
                if moving_piece.kind() == PieceKind::Pawn {
                    san.push(mv.from().file().to_char());
                }
                san.push('x');
            }

            san.push_str(&mv.to().to_algebraic());
            if let Some(promotion) = mv.promotion() {
                san.push('=');
                san.push(promotion_letter(promotion));
            }
        }

        let child = self.after_legal_move(mv)?;
        match child.status()? {
            PositionStatus::Checkmate => san.push('#'),
            PositionStatus::Ongoing if is_in_check(&child, child.side_to_move()) => san.push('+'),
            PositionStatus::Ongoing | PositionStatus::Stalemate => {}
        }

        Ok(san)
    }

    pub fn parse_san(&self, san: &str) -> Result<Move, SanError> {
        let token = normalize_san_token(san)?;
        let legal_moves = self.legal_moves()?;
        let mut matches = Vec::new();

        for mv in legal_moves {
            let rendered = self.move_to_san(mv)?;
            if san_token_matches(&token, &rendered) {
                matches.push(mv);
            }
        }

        match matches.as_slice() {
            [mv] => Ok(*mv),
            [] => Err(SanError::InvalidMove),
            _ => Err(SanError::AmbiguousMove),
        }
    }
}

fn piece_letter(kind: PieceKind) -> Option<char> {
    match kind {
        PieceKind::King => Some('K'),
        PieceKind::Queen => Some('Q'),
        PieceKind::Rook => Some('R'),
        PieceKind::Bishop => Some('B'),
        PieceKind::Knight => Some('N'),
        PieceKind::Pawn => None,
    }
}

fn promotion_letter(promotion: PromotionPiece) -> char {
    match promotion {
        PromotionPiece::Queen => 'Q',
        PromotionPiece::Rook => 'R',
        PromotionPiece::Bishop => 'B',
        PromotionPiece::Knight => 'N',
    }
}

fn is_castle(piece: Piece, mv: Move) -> bool {
    piece.kind() == PieceKind::King
        && mv.from().rank() == mv.to().rank()
        && mv.from().file().index().abs_diff(mv.to().file().index()) == 2
}

fn is_capture(position: &Position, mv: Move, piece: Piece) -> bool {
    position.piece_at(mv.to()).is_some()
        || (piece.kind() == PieceKind::Pawn
            && mv.from().file() != mv.to().file()
            && position.piece_at(mv.to()).is_none())
}

fn append_disambiguation(
    position: &Position,
    legal_moves: &[Move],
    mv: Move,
    moving_piece: Piece,
    san: &mut String,
) {
    let competitors = legal_moves
        .iter()
        .copied()
        .filter(|candidate| *candidate != mv && candidate.to() == mv.to())
        .filter(|candidate| position.piece_at(candidate.from()) == Some(moving_piece))
        .collect::<Vec<_>>();

    if competitors.is_empty() {
        return;
    }

    let same_file = competitors
        .iter()
        .any(|candidate| candidate.from().file() == mv.from().file());
    let same_rank = competitors
        .iter()
        .any(|candidate| candidate.from().rank() == mv.from().rank());

    if !same_file {
        san.push(mv.from().file().to_char());
    } else if !same_rank {
        san.push(mv.from().rank().to_char());
    } else {
        san.push_str(&mv.from().to_algebraic());
    }
}

fn normalize_san_token(san: &str) -> Result<String, SanError> {
    let token = san.trim();
    if token.is_empty() {
        return Err(SanError::Empty);
    }

    let suffix_start = token
        .char_indices()
        .rev()
        .find(|(_index, ch)| !matches!(ch, '!' | '?'))
        .map_or(0, |(index, ch)| index + ch.len_utf8());
    let suffix = &token[suffix_start..];
    if !suffix.is_empty() && !matches!(suffix, "!" | "?" | "!!" | "??" | "!?" | "?!") {
        return Err(SanError::InvalidMove);
    }
    let token = &token[..suffix_start];
    if token.is_empty() {
        return Err(SanError::Empty);
    }

    if let Some(rest) = token.strip_prefix("0-0-0") {
        return Ok(format!("O-O-O{rest}"));
    }
    if let Some(rest) = token.strip_prefix("0-0") {
        return Ok(format!("O-O{rest}"));
    }

    Ok(token.to_owned())
}

fn san_token_matches(token: &str, rendered: &str) -> bool {
    token == rendered || token == strip_terminal_marker(rendered)
}

fn strip_terminal_marker(rendered: &str) -> &str {
    rendered
        .strip_suffix('+')
        .or_else(|| rendered.strip_suffix('#'))
        .unwrap_or(rendered)
}
