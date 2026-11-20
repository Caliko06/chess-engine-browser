use core::fmt;

use crate::{LegalMoveError, Move, Position, SanError};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PgnTag {
    name: String,
    value: String,
}

impl PgnTag {
    fn new(name: impl Into<String>, value: impl Into<String>) -> Result<Self, PgnError> {
        let name = name.into();
        let value = value.into();
        if !is_valid_tag_name(&name) || value.chars().any(char::is_control) {
            return Err(PgnError::InvalidTag);
        }

        Ok(Self { name, value })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GameResult {
    WhiteWin,
    BlackWin,
    Draw,
    Ongoing,
}

impl GameResult {
    fn from_token(token: &str) -> Option<Self> {
        match token {
            "1-0" => Some(Self::WhiteWin),
            "0-1" => Some(Self::BlackWin),
            "1/2-1/2" => Some(Self::Draw),
            "*" => Some(Self::Ongoing),
            _ => None,
        }
    }

    const fn token(self) -> &'static str {
        match self {
            Self::WhiteWin => "1-0",
            Self::BlackWin => "0-1",
            Self::Draw => "1/2-1/2",
            Self::Ongoing => "*",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PgnGame {
    tags: Vec<PgnTag>,
    moves: Vec<Move>,
    result: GameResult,
}

impl PgnGame {
    pub fn from_pgn(text: &str) -> Result<Self, PgnError> {
        let (tags, movetext) = parse_sections(text)?;
        reject_unsupported_tags(&tags)?;

        let tag_result = tags
            .iter()
            .find(|tag| tag.name == "Result")
            .and_then(|tag| GameResult::from_token(&tag.value));
        let (moves, movetext_result) = parse_movetext(&movetext)?;
        let result = match (tag_result, movetext_result) {
            (Some(tag), Some(text)) if tag != text => return Err(PgnError::ResultMismatch),
            (Some(tag), _) => tag,
            (_, Some(text)) => text,
            (None, None) => GameResult::Ongoing,
        };

        Ok(Self {
            tags,
            moves,
            result,
        })
    }

    pub fn to_pgn(&self) -> Result<String, PgnError> {
        reject_unsupported_tags(&self.tags)?;
        validate_result_tag(&self.tags, self.result)?;

        let mut text = String::new();
        for tag in &self.tags {
            text.push('[');
            text.push_str(&tag.name);
            text.push_str(" \"");
            text.push_str(&escape_tag_value(&tag.value));
            text.push_str("\"]\n");
        }
        if !self.tags.is_empty() {
            text.push('\n');
        }
        text.push_str(&render_movetext(&self.moves, self.result)?);
        Ok(text)
    }

    #[must_use]
    pub fn moves(&self) -> &[Move] {
        &self.moves
    }
}

#[non_exhaustive]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PgnError {
    Empty,
    InvalidTag,
    InvalidMovetext,
    UnsupportedFeature,
    IllegalMove,
    ResultMismatch,
    San(SanError),
    LegalMove(LegalMoveError),
}

impl fmt::Display for PgnError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("PGN text must not be empty"),
            Self::InvalidTag => formatter.write_str("PGN tag pair is invalid"),
            Self::InvalidMovetext => formatter.write_str("PGN movetext is invalid"),
            Self::UnsupportedFeature => {
                formatter.write_str("PGN feature is outside the supported local-game subset")
            }
            Self::IllegalMove => formatter.write_str("PGN contains an illegal move"),
            Self::ResultMismatch => formatter.write_str("PGN result tag and movetext disagree"),
            Self::San(error) => write!(formatter, "{error}"),
            Self::LegalMove(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for PgnError {}

impl From<SanError> for PgnError {
    fn from(error: SanError) -> Self {
        Self::San(error)
    }
}

impl From<LegalMoveError> for PgnError {
    fn from(error: LegalMoveError) -> Self {
        Self::LegalMove(error)
    }
}

fn parse_sections(text: &str) -> Result<(Vec<PgnTag>, String), PgnError> {
    if text.trim().is_empty() {
        return Err(PgnError::Empty);
    }

    let mut tags = Vec::new();
    let mut movetext_lines = Vec::new();
    let mut seen_movetext = false;

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('[') {
            if seen_movetext {
                return Err(PgnError::InvalidTag);
            }
            tags.push(parse_tag(trimmed)?);
        } else {
            seen_movetext = true;
            movetext_lines.push(trimmed);
        }
    }

    Ok((tags, movetext_lines.join(" ")))
}

fn parse_tag(line: &str) -> Result<PgnTag, PgnError> {
    if !line.ends_with(']') {
        return Err(PgnError::InvalidTag);
    }
    let body = &line[1..line.len() - 1];
    let Some(space_index) = body.find(char::is_whitespace) else {
        return Err(PgnError::InvalidTag);
    };
    let name = &body[..space_index];
    let value_text = body[space_index..].trim();
    if !value_text.starts_with('"') || !value_text.ends_with('"') {
        return Err(PgnError::InvalidTag);
    }
    let value = unescape_tag_value(&value_text[1..value_text.len() - 1])?;
    PgnTag::new(name, value)
}

fn unescape_tag_value(text: &str) -> Result<String, PgnError> {
    let mut value = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if ch == '"' {
            return Err(PgnError::InvalidTag);
        }
        if ch != '\\' {
            value.push(ch);
            continue;
        }
        match chars.next() {
            Some('"') => value.push('"'),
            Some('\\') => value.push('\\'),
            _ => return Err(PgnError::InvalidTag),
        }
    }
    Ok(value)
}

fn escape_tag_value(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

fn is_valid_tag_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphabetic() && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn reject_unsupported_tags(tags: &[PgnTag]) -> Result<(), PgnError> {
    if tags
        .iter()
        .any(|tag| matches!(tag.name.as_str(), "FEN" | "SetUp"))
    {
        return Err(PgnError::UnsupportedFeature);
    }
    Ok(())
}

fn validate_result_tag(tags: &[PgnTag], result: GameResult) -> Result<(), PgnError> {
    if let Some(tag) = tags.iter().find(|tag| tag.name == "Result") {
        let Some(tag_result) = GameResult::from_token(&tag.value) else {
            return Err(PgnError::InvalidTag);
        };
        if tag_result != result {
            return Err(PgnError::ResultMismatch);
        }
    }
    Ok(())
}

fn parse_movetext(text: &str) -> Result<(Vec<Move>, Option<GameResult>), PgnError> {
    if has_unsupported_movetext(text) {
        return Err(PgnError::UnsupportedFeature);
    }

    let mut position = Position::startpos();
    let mut moves = Vec::new();
    let mut result = None;

    for raw_token in text.split_whitespace() {
        let Some(token) = strip_move_number(raw_token) else {
            continue;
        };
        if token.is_empty() {
            continue;
        }
        if let Some(parsed_result) = GameResult::from_token(token) {
            if result.replace(parsed_result).is_some() {
                return Err(PgnError::InvalidMovetext);
            }
            continue;
        }
        if result.is_some() {
            return Err(PgnError::InvalidMovetext);
        }

        let mv = position.parse_san(token).map_err(|error| match error {
            SanError::InvalidMove | SanError::AmbiguousMove | SanError::Empty => {
                PgnError::IllegalMove
            }
            other => PgnError::San(other),
        })?;
        position = position.after_legal_move(mv)?;
        moves.push(mv);
    }

    Ok((moves, result))
}

fn has_unsupported_movetext(text: &str) -> bool {
    text.chars()
        .any(|ch| matches!(ch, '{' | '}' | '(' | ')' | '$' | ';'))
}

fn strip_move_number(token: &str) -> Option<&str> {
    let bytes = token.as_bytes();
    let mut index = 0;
    while bytes.get(index).is_some_and(u8::is_ascii_digit) {
        index += 1;
    }
    if index == 0 {
        return Some(token);
    }
    if bytes.get(index) != Some(&b'.') {
        return Some(token);
    }
    while bytes.get(index) == Some(&b'.') {
        index += 1;
    }
    token.get(index..)
}

fn render_movetext(moves: &[Move], result: GameResult) -> Result<String, PgnError> {
    let mut position = Position::startpos();
    let mut text = String::new();

    for (index, mv) in moves.iter().copied().enumerate() {
        if !text.is_empty() {
            text.push(' ');
        }
        if index % 2 == 0 {
            text.push_str(&(index / 2 + 1).to_string());
            text.push('.');
            text.push(' ');
        }
        text.push_str(&position.move_to_san(mv)?);
        position = position
            .after_legal_move(mv)
            .map_err(|_error| PgnError::IllegalMove)?;
    }

    if !text.is_empty() {
        text.push(' ');
    }
    text.push_str(result.token());
    Ok(text)
}
