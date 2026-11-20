use core::fmt;

mod pgn;
#[cfg(test)]
mod property_tests;
mod san;

pub use pgn::{GameResult, PgnError, PgnGame, PgnTag};
pub use san::SanError;

const BOARD_SQUARES: usize = 64;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Color {
    White,
    Black,
}

impl Color {
    fn from_fen(text: &str) -> Result<Self, FenError> {
        match text {
            "w" => Ok(Self::White),
            "b" => Ok(Self::Black),
            _ => Err(FenError::InvalidSideToMove),
        }
    }

    fn fen_char(self) -> char {
        match self {
            Self::White => 'w',
            Self::Black => 'b',
        }
    }

    /// Returns the opposing color.
    #[must_use]
    pub const fn opposite(self) -> Self {
        match self {
            Self::White => Self::Black,
            Self::Black => Self::White,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PieceKind {
    King,
    Queen,
    Rook,
    Bishop,
    Knight,
    Pawn,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Piece {
    color: Color,
    kind: PieceKind,
}

impl Piece {
    #[must_use]
    pub const fn new(color: Color, kind: PieceKind) -> Self {
        Self { color, kind }
    }

    #[must_use]
    pub const fn color(self) -> Color {
        self.color
    }

    #[must_use]
    pub const fn kind(self) -> PieceKind {
        self.kind
    }

    fn from_fen_char(value: char) -> Option<Self> {
        let color = if value.is_ascii_uppercase() {
            Color::White
        } else {
            Color::Black
        };

        let kind = match value.to_ascii_lowercase() {
            'k' => PieceKind::King,
            'q' => PieceKind::Queen,
            'r' => PieceKind::Rook,
            'b' => PieceKind::Bishop,
            'n' => PieceKind::Knight,
            'p' => PieceKind::Pawn,
            _ => return None,
        };

        Some(Self::new(color, kind))
    }

    fn fen_char(self) -> char {
        let value = match self.kind {
            PieceKind::King => 'k',
            PieceKind::Queen => 'q',
            PieceKind::Rook => 'r',
            PieceKind::Bishop => 'b',
            PieceKind::Knight => 'n',
            PieceKind::Pawn => 'p',
        };

        match self.color {
            Color::White => value.to_ascii_uppercase(),
            Color::Black => value,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum File {
    A,
    B,
    C,
    D,
    E,
    F,
    G,
    H,
}

impl File {
    const ALL: [Self; 8] = [
        Self::A,
        Self::B,
        Self::C,
        Self::D,
        Self::E,
        Self::F,
        Self::G,
        Self::H,
    ];

    fn from_index(index: usize) -> Option<Self> {
        Self::ALL.get(index).copied()
    }

    fn from_char(value: char) -> Result<Self, SquareError> {
        match value {
            'a' => Ok(Self::A),
            'b' => Ok(Self::B),
            'c' => Ok(Self::C),
            'd' => Ok(Self::D),
            'e' => Ok(Self::E),
            'f' => Ok(Self::F),
            'g' => Ok(Self::G),
            'h' => Ok(Self::H),
            _ => Err(SquareError::InvalidFile),
        }
    }

    fn to_char(self) -> char {
        match self {
            Self::A => 'a',
            Self::B => 'b',
            Self::C => 'c',
            Self::D => 'd',
            Self::E => 'e',
            Self::F => 'f',
            Self::G => 'g',
            Self::H => 'h',
        }
    }

    fn index(self) -> usize {
        match self {
            Self::A => 0,
            Self::B => 1,
            Self::C => 2,
            Self::D => 3,
            Self::E => 4,
            Self::F => 5,
            Self::G => 6,
            Self::H => 7,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Rank {
    First,
    Second,
    Third,
    Fourth,
    Fifth,
    Sixth,
    Seventh,
    Eighth,
}

impl Rank {
    const ALL: [Self; 8] = [
        Self::First,
        Self::Second,
        Self::Third,
        Self::Fourth,
        Self::Fifth,
        Self::Sixth,
        Self::Seventh,
        Self::Eighth,
    ];

    fn from_index(index: usize) -> Option<Self> {
        Self::ALL.get(index).copied()
    }

    fn from_char(value: char) -> Result<Self, SquareError> {
        match value {
            '1' => Ok(Self::First),
            '2' => Ok(Self::Second),
            '3' => Ok(Self::Third),
            '4' => Ok(Self::Fourth),
            '5' => Ok(Self::Fifth),
            '6' => Ok(Self::Sixth),
            '7' => Ok(Self::Seventh),
            '8' => Ok(Self::Eighth),
            _ => Err(SquareError::InvalidRank),
        }
    }

    fn to_char(self) -> char {
        match self {
            Self::First => '1',
            Self::Second => '2',
            Self::Third => '3',
            Self::Fourth => '4',
            Self::Fifth => '5',
            Self::Sixth => '6',
            Self::Seventh => '7',
            Self::Eighth => '8',
        }
    }

    fn index(self) -> usize {
        match self {
            Self::First => 0,
            Self::Second => 1,
            Self::Third => 2,
            Self::Fourth => 3,
            Self::Fifth => 4,
            Self::Sixth => 5,
            Self::Seventh => 6,
            Self::Eighth => 7,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Square {
    file: File,
    rank: Rank,
}

impl Square {
    #[must_use]
    pub const fn new(file: File, rank: Rank) -> Self {
        Self { file, rank }
    }

    pub fn from_algebraic(text: &str) -> Result<Self, SquareError> {
        let mut chars = text.chars();
        let file_char = match chars.next() {
            Some(value) => value,
            None => return Err(SquareError::InvalidLength),
        };
        let rank_char = match chars.next() {
            Some(value) => value,
            None => return Err(SquareError::InvalidLength),
        };
        if chars.next().is_some() {
            return Err(SquareError::InvalidLength);
        }

        Ok(Self::new(
            File::from_char(file_char)?,
            Rank::from_char(rank_char)?,
        ))
    }

    #[must_use]
    pub fn to_algebraic(self) -> String {
        let mut value = String::with_capacity(2);
        value.push(self.file.to_char());
        value.push(self.rank.to_char());
        value
    }

    #[must_use]
    pub const fn file(self) -> File {
        self.file
    }

    #[must_use]
    pub const fn rank(self) -> Rank {
        self.rank
    }

    fn index(self) -> usize {
        (self.rank.index() * 8) + self.file.index()
    }

    /// Returns the square `file_delta` files and `rank_delta` ranks away, or `None` when that
    /// lands off the board. Positive deltas move toward the h-file and the eighth rank. This is the
    /// geometry primitive other crates use to walk rays and leaper offsets without reaching into
    /// the private file/rank indices.
    #[must_use]
    pub fn offset(self, file_delta: i8, rank_delta: i8) -> Option<Self> {
        Some(Self::new(
            offset_file(self.file, file_delta)?,
            offset_rank(self.rank, rank_delta)?,
        ))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SquareError {
    InvalidLength,
    InvalidFile,
    InvalidRank,
}

impl fmt::Display for SquareError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidLength => "square must contain exactly two characters",
            Self::InvalidFile => "square file must be a through h",
            Self::InvalidRank => "square rank must be 1 through 8",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for SquareError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PromotionPiece {
    Queen,
    Rook,
    Bishop,
    Knight,
}

impl PromotionPiece {
    fn from_coordinate_char(value: char) -> Result<Self, MoveError> {
        match value {
            'q' => Ok(Self::Queen),
            'r' => Ok(Self::Rook),
            'b' => Ok(Self::Bishop),
            'n' => Ok(Self::Knight),
            'k' | 'p' => Err(MoveError::InvalidPromotion),
            _ => Err(MoveError::InvalidCoordinate),
        }
    }

    const fn coordinate_char(self) -> char {
        match self {
            Self::Queen => 'q',
            Self::Rook => 'r',
            Self::Bishop => 'b',
            Self::Knight => 'n',
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Move {
    from: Square,
    to: Square,
    promotion: Option<PromotionPiece>,
}

impl Move {
    pub fn new(
        from: Square,
        to: Square,
        promotion: Option<PromotionPiece>,
    ) -> Result<Self, MoveError> {
        if from == to {
            return Err(MoveError::SameSquare);
        }
        if promotion.is_some() && !is_promotion_rank_transition(from, to) {
            return Err(MoveError::InvalidPromotion);
        }

        Ok(Self {
            from,
            to,
            promotion,
        })
    }

    pub fn from_coordinate(text: &str) -> Result<Self, MoveError> {
        let bytes = text.as_bytes();
        if !(bytes.len() == 4 || bytes.len() == 5) || !bytes.iter().all(u8::is_ascii) {
            return Err(MoveError::InvalidCoordinate);
        }

        let from =
            Square::from_algebraic(&text[0..2]).map_err(|_error| MoveError::InvalidCoordinate)?;
        let to =
            Square::from_algebraic(&text[2..4]).map_err(|_error| MoveError::InvalidCoordinate)?;
        let promotion = if bytes.len() == 5 {
            Some(PromotionPiece::from_coordinate_char(char::from(bytes[4]))?)
        } else {
            None
        };

        Self::new(from, to, promotion)
    }

    #[must_use]
    pub fn to_coordinate(&self) -> String {
        let mut text = String::with_capacity(5);
        text.push_str(&self.from.to_algebraic());
        text.push_str(&self.to.to_algebraic());
        if let Some(promotion) = self.promotion {
            text.push(promotion.coordinate_char());
        }

        text
    }

    #[must_use]
    pub const fn from(self) -> Square {
        self.from
    }

    #[must_use]
    pub const fn to(self) -> Square {
        self.to
    }

    #[must_use]
    pub const fn promotion(self) -> Option<PromotionPiece> {
        self.promotion
    }

    /// Numeric key whose order equals the lexicographic order of [`Move::to_coordinate`]: from
    /// file, from rank, to file, to rank, then the promotion suffix with absence sorting first
    /// and the suffix characters in ASCII order (`b` < `n` < `q` < `r`).
    fn coordinate_sort_key(self) -> u16 {
        let promotion_rank: u16 = match self.promotion {
            None => 0,
            Some(PromotionPiece::Bishop) => 1,
            Some(PromotionPiece::Knight) => 2,
            Some(PromotionPiece::Queen) => 3,
            Some(PromotionPiece::Rook) => 4,
        };
        let squares = [
            self.from.file().index(),
            self.from.rank().index(),
            self.to.file().index(),
            self.to.rank().index(),
        ]
        .into_iter()
        .fold(0_u16, |key, index| (key * 8) + index as u16);
        (squares * 5) + promotion_rank
    }
}

/// Moves order by their coordinate text ([`Move::to_coordinate`]), so sorting or comparing moves
/// reproduces the deterministic coordinate-string order without allocating.
impl Ord for Move {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.coordinate_sort_key().cmp(&other.coordinate_sort_key())
    }
}

impl PartialOrd for Move {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// Fixed-capacity move buffer for search: filling it never allocates. 256 covers every
/// pseudo-legal list of a valid position (the legal maximum is 218).
#[derive(Clone)]
pub struct MoveList {
    moves: [Move; MoveList::CAPACITY],
    len: usize,
}

impl MoveList {
    pub const CAPACITY: usize = 256;

    #[must_use]
    pub fn new() -> Self {
        const PLACEHOLDER: Move = Move {
            from: Square::new(File::A, Rank::First),
            to: Square::new(File::A, Rank::Second),
            promotion: None,
        };
        Self {
            moves: [PLACEHOLDER; Self::CAPACITY],
            len: 0,
        }
    }

    pub fn clear(&mut self) {
        self.len = 0;
    }

    /// Panics when the buffer is full, which a valid position cannot cause.
    pub fn push(&mut self, mv: Move) {
        self.moves[self.len] = mv;
        self.len += 1;
    }
}

impl Default for MoveList {
    fn default() -> Self {
        Self::new()
    }
}

impl std::ops::Deref for MoveList {
    type Target = [Move];

    fn deref(&self) -> &[Move] {
        &self.moves[..self.len]
    }
}

impl std::ops::DerefMut for MoveList {
    fn deref_mut(&mut self) -> &mut [Move] {
        &mut self.moves[..self.len]
    }
}

fn is_promotion_rank_transition(from: Square, to: Square) -> bool {
    matches!(
        (from.rank(), to.rank()),
        (Rank::Seventh, Rank::Eighth) | (Rank::Second, Rank::First)
    )
}

#[non_exhaustive]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MoveError {
    InvalidCoordinate,
    InvalidPromotion,
    SameSquare,
}

impl fmt::Display for MoveError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidCoordinate => "move coordinate must be e2e4 or e7e8q style text",
            Self::InvalidPromotion => "move promotion must be queen, rook, bishop, or knight",
            Self::SameSquare => "move source and destination squares must differ",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for MoveError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CastlingRights {
    white_kingside: bool,
    white_queenside: bool,
    black_kingside: bool,
    black_queenside: bool,
}

impl CastlingRights {
    #[must_use]
    pub const fn none() -> Self {
        Self {
            white_kingside: false,
            white_queenside: false,
            black_kingside: false,
            black_queenside: false,
        }
    }

    #[must_use]
    pub const fn all() -> Self {
        Self {
            white_kingside: true,
            white_queenside: true,
            black_kingside: true,
            black_queenside: true,
        }
    }

    #[must_use]
    pub const fn white_kingside(self) -> bool {
        self.white_kingside
    }

    #[must_use]
    pub const fn white_queenside(self) -> bool {
        self.white_queenside
    }

    #[must_use]
    pub const fn black_kingside(self) -> bool {
        self.black_kingside
    }

    #[must_use]
    pub const fn black_queenside(self) -> bool {
        self.black_queenside
    }

    fn from_fen(text: &str) -> Result<Self, FenError> {
        if text == "-" {
            return Ok(Self::none());
        }

        let mut rights = Self::none();
        for value in text.chars() {
            match value {
                'K' if !rights.white_kingside => rights.white_kingside = true,
                'Q' if !rights.white_queenside => rights.white_queenside = true,
                'k' if !rights.black_kingside => rights.black_kingside = true,
                'q' if !rights.black_queenside => rights.black_queenside = true,
                _ => return Err(FenError::InvalidCastling),
            }
        }

        Ok(rights)
    }

    fn fen_text(self) -> String {
        let mut text = String::with_capacity(4);
        if self.white_kingside {
            text.push('K');
        }
        if self.white_queenside {
            text.push('Q');
        }
        if self.black_kingside {
            text.push('k');
        }
        if self.black_queenside {
            text.push('q');
        }

        if text.is_empty() {
            text.push('-');
        }

        text
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Position {
    board: [Option<Piece>; BOARD_SQUARES],
    bitboards: Bitboards,
    hash: u64,
    side_to_move: Color,
    castling_rights: CastlingRights,
    en_passant_target: Option<Square>,
    halfmove_clock: u32,
    fullmove_number: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct BoardState {
    board: [Option<Piece>; BOARD_SQUARES],
    bitboards: Bitboards,
    hash: u64,
    side_to_move: Color,
    castling_rights: CastlingRights,
    en_passant_target: Option<Square>,
    halfmove_clock: u32,
    fullmove_number: u32,
}

impl Position {
    #[must_use]
    pub fn startpos() -> Self {
        let mut board = [None; BOARD_SQUARES];
        let white_back_rank = [
            PieceKind::Rook,
            PieceKind::Knight,
            PieceKind::Bishop,
            PieceKind::Queen,
            PieceKind::King,
            PieceKind::Bishop,
            PieceKind::Knight,
            PieceKind::Rook,
        ];

        for (file_index, kind) in white_back_rank.into_iter().enumerate() {
            if let Some(file) = File::from_index(file_index) {
                board[Square::new(file, Rank::First).index()] =
                    Some(Piece::new(Color::White, kind));
                board[Square::new(file, Rank::Second).index()] =
                    Some(Piece::new(Color::White, PieceKind::Pawn));
                board[Square::new(file, Rank::Seventh).index()] =
                    Some(Piece::new(Color::Black, PieceKind::Pawn));
                board[Square::new(file, Rank::Eighth).index()] =
                    Some(Piece::new(Color::Black, kind));
            }
        }

        let mut position = Self {
            bitboards: Bitboards::scan(&board),
            board,
            hash: 0,
            side_to_move: Color::White,
            castling_rights: CastlingRights::all(),
            en_passant_target: None,
            halfmove_clock: 0,
            fullmove_number: 1,
        };
        position.hash = zobrist_hash(&position);
        position
    }

    pub fn from_fen(fen: &str) -> Result<Self, FenError> {
        let fields = fen.split(' ').collect::<Vec<_>>();
        if fields.len() != 6 || fields.iter().any(|field| field.is_empty()) {
            return Err(FenError::FieldCount);
        }
        if fen
            .bytes()
            .any(|value| value.is_ascii_whitespace() && value != b' ')
        {
            return Err(FenError::FieldCount);
        }

        let board = parse_board(fields[0])?;
        let side_to_move = Color::from_fen(fields[1])?;
        let castling_rights = CastlingRights::from_fen(fields[2])?;
        let en_passant_target = parse_en_passant(fields[3], side_to_move)?;
        let halfmove_clock = parse_counter(fields[4], CounterField::HalfmoveClock)?;
        let fullmove_number = parse_counter(fields[5], CounterField::FullmoveNumber)?;

        let mut position = Self {
            bitboards: Bitboards::scan(&board),
            board,
            hash: 0,
            side_to_move,
            castling_rights,
            en_passant_target,
            halfmove_clock,
            fullmove_number,
        };
        position.hash = zobrist_hash(&position);
        Ok(position)
    }

    #[must_use]
    pub fn to_fen(&self) -> String {
        format!(
            "{} {} {} {} {} {}",
            self.board_fen(),
            self.side_to_move.fen_char(),
            self.castling_rights.fen_text(),
            self.en_passant_target
                .map_or_else(|| "-".to_string(), Square::to_algebraic),
            self.halfmove_clock,
            self.fullmove_number
        )
    }

    #[must_use]
    pub fn piece_at(&self, square: Square) -> Option<Piece> {
        self.board[square.index()]
    }

    #[must_use]
    pub const fn side_to_move(&self) -> Color {
        self.side_to_move
    }

    /// Returns whether the side to move is currently in check.
    #[must_use]
    pub fn is_check(&self) -> bool {
        is_in_check(self, self.side_to_move)
    }

    /// Returns whether `mv` captures an enemy piece, including en passant.
    ///
    /// This is a static board predicate: it does not verify that `mv` is legal. For a legal
    /// move of the side to move a non-empty destination is always an enemy piece, so the
    /// occupancy check suffices; the en passant branch covers the capture where the captured
    /// pawn does not sit on the destination square.
    #[must_use]
    pub fn is_capture(&self, mv: Move) -> bool {
        if self.piece_at(mv.to).is_some() {
            return true;
        }
        matches!(self.en_passant_target, Some(target) if target == mv.to)
            && matches!(self.piece_at(mv.from), Some(piece) if piece.kind == PieceKind::Pawn)
    }

    #[must_use]
    pub const fn castling_rights(&self) -> CastlingRights {
        self.castling_rights
    }

    #[must_use]
    pub const fn en_passant_target(&self) -> Option<Square> {
        self.en_passant_target
    }

    #[must_use]
    pub const fn halfmove_clock(&self) -> u32 {
        self.halfmove_clock
    }

    #[must_use]
    pub const fn is_fifty_move_draw(&self) -> bool {
        self.halfmove_clock >= 100
    }

    #[must_use]
    pub fn has_insufficient_material(&self) -> bool {
        has_insufficient_material(self)
    }

    #[must_use]
    pub const fn fullmove_number(&self) -> u32 {
        self.fullmove_number
    }

    /// Returns complete legal moves in deterministic coordinate-string order.
    pub fn legal_moves(&self) -> Result<Vec<Move>, LegalMoveError> {
        if classify_position(self)
            .into_iter()
            .any(PositionIssue::blocks_legal_moves)
        {
            return Err(LegalMoveError::InvalidPosition);
        }

        let mut moves = generate_legal_moves(self);
        moves.sort_unstable();
        Ok(moves)
    }

    /// [`Position::legal_moves`] without the entry-point position validation
    /// (`classify_position`), which costs an extra check/material/castling scan per call and a
    /// second full move generation whenever an en-passant target is set.
    ///
    /// Contract: the position was produced by the board from a validated position
    /// ([`Position::after_legal_move`]/[`Position::after_known_legal_move`] children), or has
    /// itself already passed `status()`/`legal_moves()`. Move application preserves validity by
    /// construction and normalizes the en-passant target to "set only when legally capturable",
    /// so derived positions always classify clean. Untrusted entry points (FEN, CLI, wasm
    /// bridge) must keep using the validating methods.
    #[must_use]
    pub fn legal_moves_trusted(&self) -> Vec<Move> {
        let mut moves = generate_legal_moves(self);
        moves.sort_unstable();
        moves
    }

    /// Returns the terminal status using the complete legal move path.
    pub fn status(&self) -> Result<PositionStatus, LegalMoveError> {
        if classify_position(self)
            .into_iter()
            .any(PositionIssue::blocks_legal_moves)
        {
            return Err(LegalMoveError::InvalidPosition);
        }

        Ok(PositionStatus::from(terminal_status(self)))
    }

    /// [`Position::status`] through the trusted path: same contract as
    /// [`Position::legal_moves_trusted`].
    #[must_use]
    pub fn status_trusted(&self) -> PositionStatus {
        PositionStatus::from(terminal_status(self))
    }

    /// True when the side to move has at least one legal move, stopping at the first survivor
    /// instead of generating, filtering and sorting the complete list. Same trust contract as
    /// [`Position::legal_moves_trusted`].
    #[must_use]
    pub fn has_any_legal_move_trusted(&self) -> bool {
        has_any_legal_move(self)
    }

    /// Returns the child position after applying one complete legal move.
    pub fn after_legal_move(&self, mv: Move) -> Result<Self, LegalMoveError> {
        if !self.legal_moves()?.contains(&mv) {
            return Err(LegalMoveError::InvalidPosition);
        }

        let mut child = self.clone();
        if make_move_in_place(&mut child, mv).is_none() {
            return Err(LegalMoveError::InvalidPosition);
        }
        Ok(child)
    }

    /// Returns the child position after applying a move taken from this position's own legal
    /// move list, without regenerating that list to revalidate it.
    ///
    /// Contract: `mv` must come from a `legal_moves()` (or equivalent) call on this exact
    /// position. The search qualifies because it only ever applies moves it just generated;
    /// untrusted callers (CLI, wasm bridge) must keep using [`Position::after_legal_move`].
    pub fn after_known_legal_move(&self, mv: Move) -> Result<Self, LegalMoveError> {
        let mut child = self.clone();
        if make_move_in_place(&mut child, mv).is_none() {
            return Err(LegalMoveError::InvalidPosition);
        }
        Ok(child)
    }

    /// Replaces `out` with the pseudo-legal moves of the side to move, unsorted: every move
    /// obeys piece geometry and may leave the own king attacked, except castling, which is fully
    /// legal. Filter with [`Position::after_pseudo_move`]. Same trust contract as
    /// [`Position::legal_moves_trusted`].
    pub fn pseudo_legal_moves_into(&self, out: &mut MoveList) {
        out.clear();
        generate_pseudo_moves(self, false, out);
    }

    /// Like [`Position::pseudo_legal_moves_into`] but only captures (en passant included) and
    /// queen promotions, the moves a quiescence search looks at when not in check.
    pub fn pseudo_legal_captures_into(&self, out: &mut MoveList) {
        out.clear();
        generate_pseudo_moves(self, true, out);
    }

    /// Applies a move produced by [`Position::pseudo_legal_moves_into`] or
    /// [`Position::pseudo_legal_captures_into`] on this exact position. Returns `None` when it
    /// leaves the mover's own king attacked, so the moves that return `Some` are exactly
    /// [`Position::legal_moves_trusted`].
    #[must_use]
    pub fn after_pseudo_move(&self, mv: Move) -> Option<Self> {
        let mut child = self.clone();
        make_generated_move(&mut child, mv);
        (!is_in_check(&child, self.side_to_move)).then_some(child)
    }

    /// Whether the generated move `mv` checks the enemy king, decided on bitboards without
    /// making the move: equals `after_pseudo_move(mv)?.is_check()`. Search uses it to prune
    /// before paying for the full move.
    #[must_use]
    pub fn gives_check(&self, mv: Move) -> bool {
        let us = self.side_to_move;
        let them = us.opposite();
        let bitboards = &self.bitboards;
        let kings = bitboards.pieces(them, PieceKind::King);
        let Some(moving) = self.board[mv.from.index()] else {
            return false;
        };
        if kings == 0 {
            return false;
        }
        let king = kings.trailing_zeros() as usize;
        let (from, to) = (1_u64 << mv.from.index(), 1_u64 << mv.to.index());
        let mut occupied = (bitboards.occupied() ^ from) | to;
        let mut ours = bitboards.kinds;
        for bits in &mut ours {
            *bits &= bitboards.colors[us as usize] & !from;
        }
        let placed = mv.promotion.map_or(moving.kind, promotion_piece_kind);
        ours[placed as usize] |= to;
        if moving.kind == PieceKind::Pawn
            && mv.from.file != mv.to.file
            && self.board[mv.to.index()].is_none()
        {
            occupied ^= 1 << Square::new(mv.to.file, mv.from.rank).index();
        }
        if let Some(side) = castle_side_for_move(us, moving, mv) {
            let (rook_from, rook_to) = castle_rook_squares(us, side);
            let rook = (1_u64 << rook_from.index()) | (1_u64 << rook_to.index());
            occupied ^= rook;
            ours[PieceKind::Rook as usize] ^= rook;
        }
        let diagonal = ours[PieceKind::Bishop as usize] | ours[PieceKind::Queen as usize];
        let straight = ours[PieceKind::Rook as usize] | ours[PieceKind::Queen as usize];
        PAWN_ATTACKS[them as usize][king] & ours[PieceKind::Pawn as usize] != 0
            || KNIGHT_ATTACKS[king] & ours[PieceKind::Knight as usize] != 0
            || bishop_attacks(king, occupied) & diagonal != 0
            || rook_attacks(king, occupied) & straight != 0
    }

    /// Every occupied square as a bitboard (bit `rank * 8 + file`, so a1 is bit 0).
    #[must_use]
    pub fn occupied_bitboard(&self) -> u64 {
        self.bitboards.occupied()
    }

    /// The squares holding `color` pieces of `kind`, in the [`Position::occupied_bitboard`] layout.
    #[must_use]
    pub fn piece_bitboard(&self, color: Color, kind: PieceKind) -> u64 {
        self.bitboards.pieces(color, kind)
    }

    /// Pieces of both colors that attack `square` when the board holds `occupied`, which lets a
    /// static exchange evaluation remove pieces and uncover x-ray attackers. The result is not
    /// masked by `occupied`.
    #[must_use]
    pub fn attackers_to(&self, square: Square, occupied: u64) -> u64 {
        let bitboards = &self.bitboards;
        let index = square.index();
        let pieces = |kind: PieceKind| bitboards.kinds[kind as usize];
        let diagonal = pieces(PieceKind::Bishop) | pieces(PieceKind::Queen);
        let straight = pieces(PieceKind::Rook) | pieces(PieceKind::Queen);
        (PAWN_ATTACKS[Color::Black as usize][index]
            & bitboards.pieces(Color::White, PieceKind::Pawn))
            | (PAWN_ATTACKS[Color::White as usize][index]
                & bitboards.pieces(Color::Black, PieceKind::Pawn))
            | (KNIGHT_ATTACKS[index] & pieces(PieceKind::Knight))
            | (KING_ATTACKS[index] & pieces(PieceKind::King))
            | (bishop_attacks(index, occupied) & diagonal)
            | (rook_attacks(index, occupied) & straight)
    }

    /// Whether `color` owns any knight, bishop, rook or queen.
    #[must_use]
    pub fn has_non_pawn_material(&self, color: Color) -> bool {
        let bitboards = &self.bitboards;
        let minors_and_majors = bitboards.kinds[PieceKind::Knight as usize]
            | bitboards.kinds[PieceKind::Bishop as usize]
            | bitboards.kinds[PieceKind::Rook as usize]
            | bitboards.kinds[PieceKind::Queen as usize];
        bitboards.colors[color as usize] & minors_and_majors != 0
    }

    /// Search-only pass: the caller must ensure the side to move is not in check.
    /// Pieces and castling rights stay put; the en passant opportunity expires.
    #[must_use]
    pub fn after_null_move(&self) -> Self {
        let mut child = self.clone();
        child.hash ^= zobrist_key(ZOBRIST_SIDE_FEATURE);
        if let Some(target) = child.en_passant_target.take() {
            child.hash ^= zobrist_key(ZOBRIST_EN_PASSANT_FEATURES + square_index_u64(target));
        }
        child.side_to_move = self.side_to_move.opposite();
        child.halfmove_clock = child.halfmove_clock.saturating_add(1);
        if self.side_to_move == Color::Black {
            child.fullmove_number = child.fullmove_number.saturating_add(1);
        }
        child
    }

    #[must_use]
    pub fn zobrist_hash(&self) -> u64 {
        self.hash
    }

    fn board_state(&self) -> BoardState {
        BoardState {
            board: self.board,
            bitboards: self.bitboards,
            hash: self.hash,
            side_to_move: self.side_to_move,
            castling_rights: self.castling_rights,
            en_passant_target: self.en_passant_target,
            halfmove_clock: self.halfmove_clock,
            fullmove_number: self.fullmove_number,
        }
    }

    fn restore_board_state(&mut self, state: BoardState) {
        self.board = state.board;
        self.bitboards = state.bitboards;
        self.hash = state.hash;
        self.side_to_move = state.side_to_move;
        self.castling_rights = state.castling_rights;
        self.en_passant_target = state.en_passant_target;
        self.halfmove_clock = state.halfmove_clock;
        self.fullmove_number = state.fullmove_number;
    }

    /// The only way to change a square after construction, so `board` and `bitboards` never
    /// disagree.
    fn set_piece(&mut self, square: Square, piece: Option<Piece>) {
        let index = square.index();
        if let Some(old) = self.board[index] {
            self.bitboards.toggle(old, index);
            self.hash ^= zobrist_key(piece_feature_index(old, square));
        }
        if let Some(new) = piece {
            self.bitboards.toggle(new, index);
            self.hash ^= zobrist_key(piece_feature_index(new, square));
        }
        self.board[index] = piece;
    }

    /// Counts legal move-tree leaves through the complete legal move path.
    pub fn perft(&self, depth: u8) -> Result<u64, LegalMoveError> {
        perft_nodes(self, depth)
    }

    /// Returns root move node counts for perft mismatch diagnosis.
    pub fn perft_divide(&self, depth: u8) -> Result<Vec<PerftDivideEntry>, LegalMoveError> {
        perft_divide(self, depth)
    }

    fn board_fen(&self) -> String {
        let mut text = String::new();

        for rank_index in (0..8).rev() {
            if rank_index != 7 {
                text.push('/');
            }

            let mut empty_run = 0_u8;
            for file_index in 0..8 {
                let index = (rank_index * 8) + file_index;
                match self.board[index] {
                    Some(piece) => {
                        if empty_run > 0 {
                            text.push(char::from(b'0' + empty_run));
                            empty_run = 0;
                        }
                        text.push(piece.fen_char());
                    }
                    None => empty_run += 1,
                }
            }

            if empty_run > 0 {
                text.push(char::from(b'0' + empty_run));
            }
        }

        text
    }
}

#[non_exhaustive]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FenError {
    FieldCount,
    BoardRankCount,
    BoardFileCount,
    InvalidPiece,
    InvalidSideToMove,
    InvalidCastling,
    InvalidEnPassant,
    InvalidHalfmoveClock,
    InvalidFullmoveNumber,
    MissingKing(Color),
    DuplicateKing(Color),
    PawnOnBackRank,
    AdjacentKings,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CounterField {
    HalfmoveClock,
    FullmoveNumber,
}

impl CounterField {
    const fn error(self) -> FenError {
        match self {
            Self::HalfmoveClock => FenError::InvalidHalfmoveClock,
            Self::FullmoveNumber => FenError::InvalidFullmoveNumber,
        }
    }
}

impl fmt::Display for FenError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::FieldCount => formatter.write_str("FEN must contain exactly six fields"),
            Self::BoardRankCount => formatter.write_str("FEN board must contain eight ranks"),
            Self::BoardFileCount => {
                formatter.write_str("each FEN board rank must contain eight files")
            }
            Self::InvalidPiece => {
                formatter.write_str("FEN board contains an invalid piece character")
            }
            Self::InvalidSideToMove => formatter.write_str("FEN side-to-move field must be w or b"),
            Self::InvalidCastling => formatter.write_str("FEN castling field is invalid"),
            Self::InvalidEnPassant => formatter.write_str("FEN en-passant target is invalid"),
            Self::InvalidHalfmoveClock => {
                formatter.write_str("FEN halfmove clock must be a non-negative integer")
            }
            Self::InvalidFullmoveNumber => {
                formatter.write_str("FEN fullmove number must be at least one")
            }
            Self::MissingKing(color) => write!(formatter, "FEN is missing a {color:?} king"),
            Self::DuplicateKing(color) => write!(formatter, "FEN has multiple {color:?} kings"),
            Self::PawnOnBackRank => {
                formatter.write_str("FEN contains a pawn on the first or eighth rank")
            }
            Self::AdjacentKings => formatter.write_str("FEN contains adjacent kings"),
        }
    }
}

impl std::error::Error for FenError {}

#[non_exhaustive]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LegalMoveError {
    /// The position parsed structurally but violates the semantic preconditions
    /// required for public legal move generation.
    InvalidPosition,
    /// The node count exceeded the supported `u64` result range.
    NodeCountOverflow,
}

impl fmt::Display for LegalMoveError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPosition => {
                formatter.write_str("position has semantic issues and cannot produce legal moves")
            }
            Self::NodeCountOverflow => formatter.write_str("perft node count exceeded u64 range"),
        }
    }
}

impl std::error::Error for LegalMoveError {}

const ZOBRIST_SEED: u64 = 0x9e37_79b9_7f4a_7c15;
const ZOBRIST_PIECE_FEATURES: u64 = 12 * 64;
const ZOBRIST_SIDE_FEATURE: u64 = ZOBRIST_PIECE_FEATURES;
const ZOBRIST_CASTLING_FEATURES: u64 = ZOBRIST_SIDE_FEATURE + 1;
const ZOBRIST_EN_PASSANT_FEATURES: u64 = ZOBRIST_CASTLING_FEATURES + 4;

fn zobrist_hash(position: &Position) -> u64 {
    let mut hash = 0_u64;

    for index in bit_indices(position.bitboards.occupied()) {
        if let Some(piece) = position.board[index] {
            hash ^= zobrist_key(piece_feature_index(piece, SQUARES[index]));
        }
    }

    hash ^ zobrist_state_hash(position)
}

fn zobrist_state_hash(position: &Position) -> u64 {
    let mut hash = 0;
    if position.side_to_move() == Color::Black {
        hash ^= zobrist_key(ZOBRIST_SIDE_FEATURE);
    }

    let rights = position.castling_rights();
    if rights.white_kingside() {
        hash ^= zobrist_key(ZOBRIST_CASTLING_FEATURES);
    }
    if rights.white_queenside() {
        hash ^= zobrist_key(ZOBRIST_CASTLING_FEATURES + 1);
    }
    if rights.black_kingside() {
        hash ^= zobrist_key(ZOBRIST_CASTLING_FEATURES + 2);
    }
    if rights.black_queenside() {
        hash ^= zobrist_key(ZOBRIST_CASTLING_FEATURES + 3);
    }

    if let Some(target) = position.en_passant_target() {
        hash ^= zobrist_key(ZOBRIST_EN_PASSANT_FEATURES + square_index_u64(target));
    }

    hash
}

fn piece_feature_index(piece: Piece, square: Square) -> u64 {
    ((color_index(piece.color()) * 6 + piece_kind_index(piece.kind())) * 64)
        + square_index_u64(square)
}

const fn color_index(color: Color) -> u64 {
    match color {
        Color::White => 0,
        Color::Black => 1,
    }
}

const fn piece_kind_index(kind: PieceKind) -> u64 {
    match kind {
        PieceKind::King => 0,
        PieceKind::Queen => 1,
        PieceKind::Rook => 2,
        PieceKind::Bishop => 3,
        PieceKind::Knight => 4,
        PieceKind::Pawn => 5,
    }
}

fn square_index_u64(square: Square) -> u64 {
    u64::try_from(square.index()).unwrap_or(u64::MAX)
}

const ZOBRIST_FEATURE_COUNT: usize = ZOBRIST_EN_PASSANT_FEATURES as usize + BOARD_SQUARES;

/// Every Zobrist key, derived once at compile time instead of hashing on each lookup.
static ZOBRIST_KEYS: [u64; ZOBRIST_FEATURE_COUNT] = {
    let mut keys = [0; ZOBRIST_FEATURE_COUNT];
    let mut feature = 0;
    while feature < ZOBRIST_FEATURE_COUNT {
        keys[feature] = splitmix64(ZOBRIST_SEED ^ feature as u64);
        feature += 1;
    }
    keys
};

#[inline]
fn zobrist_key(feature_index: u64) -> u64 {
    ZOBRIST_KEYS[feature_index as usize]
}

const fn splitmix64(mut value: u64) -> u64 {
    value = value.wrapping_add(0x9e37_79b9_7f4a_7c15);
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PositionStatus {
    Ongoing,
    Checkmate,
    Stalemate,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PerftDivideEntry {
    mv: Move,
    nodes: u64,
}

impl PerftDivideEntry {
    #[must_use]
    pub const fn mv(self) -> Move {
        self.mv
    }

    #[must_use]
    pub const fn nodes(self) -> u64 {
        self.nodes
    }
}

fn parse_board(text: &str) -> Result<[Option<Piece>; BOARD_SQUARES], FenError> {
    let ranks = text.split('/').collect::<Vec<_>>();
    if ranks.len() != 8 {
        return Err(FenError::BoardRankCount);
    }

    let mut board = [None; BOARD_SQUARES];
    let mut white_king = None;
    let mut black_king = None;

    for (fen_rank_index, rank_text) in ranks.into_iter().enumerate() {
        let rank_index = 7_usize
            .checked_sub(fen_rank_index)
            .ok_or(FenError::BoardRankCount)?;
        let rank = Rank::from_index(rank_index).ok_or(FenError::BoardRankCount)?;
        let mut file_index = 0_usize;

        let mut previous_was_digit = false;
        for value in rank_text.chars() {
            if value.is_ascii_digit() {
                if previous_was_digit {
                    return Err(FenError::BoardFileCount);
                }
                previous_was_digit = true;
                let Some(empty_count) = value.to_digit(10) else {
                    return Err(FenError::BoardFileCount);
                };
                if !(1..=8).contains(&empty_count) {
                    return Err(FenError::BoardFileCount);
                }
                file_index += empty_count as usize;
                if file_index > 8 {
                    return Err(FenError::BoardFileCount);
                }
                continue;
            }

            let piece = Piece::from_fen_char(value).ok_or(FenError::InvalidPiece)?;
            previous_was_digit = false;
            let file = File::from_index(file_index).ok_or(FenError::BoardFileCount)?;
            let square = Square::new(file, rank);

            if piece.kind() == PieceKind::Pawn && matches!(rank, Rank::First | Rank::Eighth) {
                return Err(FenError::PawnOnBackRank);
            }

            if piece.kind() == PieceKind::King {
                match piece.color() {
                    Color::White => {
                        if white_king.replace(square).is_some() {
                            return Err(FenError::DuplicateKing(Color::White));
                        }
                    }
                    Color::Black => {
                        if black_king.replace(square).is_some() {
                            return Err(FenError::DuplicateKing(Color::Black));
                        }
                    }
                }
            }

            board[square.index()] = Some(piece);
            file_index += 1;
        }

        if file_index != 8 {
            return Err(FenError::BoardFileCount);
        }
    }

    let white_king = white_king.ok_or(FenError::MissingKing(Color::White))?;
    let black_king = black_king.ok_or(FenError::MissingKing(Color::Black))?;

    if kings_are_adjacent(white_king, black_king) {
        return Err(FenError::AdjacentKings);
    }

    Ok(board)
}

fn parse_counter(text: &str, field: CounterField) -> Result<u32, FenError> {
    if text.is_empty() || !text.bytes().all(|value| value.is_ascii_digit()) {
        return Err(field.error());
    }
    if text.len() > 1 && text.as_bytes()[0] == b'0' {
        return Err(field.error());
    }

    let value = text.parse::<u32>().map_err(|_error| field.error())?;
    if field == CounterField::FullmoveNumber && value == 0 {
        return Err(FenError::InvalidFullmoveNumber);
    }

    Ok(value)
}

fn parse_en_passant(text: &str, side_to_move: Color) -> Result<Option<Square>, FenError> {
    if text == "-" {
        return Ok(None);
    }

    let square = Square::from_algebraic(text).map_err(|_error| FenError::InvalidEnPassant)?;
    let expected_rank = match side_to_move {
        Color::White => Rank::Sixth,
        Color::Black => Rank::Third,
    };
    if square.rank() != expected_rank {
        return Err(FenError::InvalidEnPassant);
    }

    Ok(Some(square))
}

fn kings_are_adjacent(white: Square, black: Square) -> bool {
    let file_distance = white.file().index().abs_diff(black.file().index());
    let rank_distance = white.rank().index().abs_diff(black.rank().index());

    file_distance <= 1 && rank_distance <= 1
}

const PROMOTION_PIECES: [PromotionPiece; 4] = [
    PromotionPiece::Queen,
    PromotionPiece::Rook,
    PromotionPiece::Bishop,
    PromotionPiece::Knight,
];

pub(crate) fn generate_pawn_pseudo_moves(position: &Position, color: Color) -> Vec<Move> {
    let mut moves = Vec::new();
    push_pawn_pseudo_moves(position, color, &mut moves);
    moves
}

fn push_pawn_pseudo_moves(position: &Position, color: Color, moves: &mut Vec<Move>) {
    for from in bit_indices(position.bitboards.pieces(color, PieceKind::Pawn)) {
        let from = SQUARES[from];
        add_pawn_quiet_moves(position, color, from, moves);
        add_pawn_captures(position, color, from, moves);
        add_pawn_en_passant(position, color, from, moves);
    }
}

// Keep the internal M4a helper lint-clean until later movegen slices consume it.
const _: fn(&Position, Color) -> Vec<Move> = generate_pawn_pseudo_moves;

fn add_pawn_quiet_moves(position: &Position, color: Color, from: Square, moves: &mut Vec<Move>) {
    let Some(one_step_rank) = pawn_forward_rank(color, from.rank(), 1) else {
        return;
    };
    let one_step = Square::new(from.file(), one_step_rank);
    if position.piece_at(one_step).is_some() {
        return;
    }

    add_pawn_candidate(from, one_step, moves);

    if from.rank() != pawn_start_rank(color) {
        return;
    }

    let Some(two_step_rank) = pawn_forward_rank(color, from.rank(), 2) else {
        return;
    };
    let two_step = Square::new(from.file(), two_step_rank);
    if position.piece_at(two_step).is_none() {
        add_pawn_candidate(from, two_step, moves);
    }
}

fn add_pawn_captures(position: &Position, color: Color, from: Square, moves: &mut Vec<Move>) {
    let enemies = position.bitboards.colors[color.opposite() as usize];
    for to in bit_indices(PAWN_ATTACKS[color as usize][from.index()] & enemies) {
        add_pawn_candidate(from, SQUARES[to], moves);
    }
}

fn add_pawn_en_passant(position: &Position, color: Color, from: Square, moves: &mut Vec<Move>) {
    let Some(target) = position.en_passant_target() else {
        return;
    };
    if !is_valid_en_passant(position, color, from, target) {
        return;
    }
    if let Ok(candidate) = Move::new(from, target, None) {
        moves.push(candidate);
    }
}

fn is_valid_en_passant(position: &Position, color: Color, from: Square, target: Square) -> bool {
    if position.en_passant_target() != Some(target)
        || position.piece_at(from) != Some(Piece::new(color, PieceKind::Pawn))
        || position.piece_at(target).is_some()
        || from.rank() != en_passant_attacker_rank(color)
        || target.rank() != en_passant_target_rank(color)
        || from.file().index().abs_diff(target.file().index()) != 1
    {
        return false;
    }

    en_passant_captured_square(color, target).is_some_and(|square| {
        position.piece_at(square) == Some(Piece::new(color.opposite(), PieceKind::Pawn))
    })
}

fn en_passant_captured_square(color: Color, target: Square) -> Option<Square> {
    let captured_rank = match color {
        Color::White => offset_rank(target.rank(), -1),
        Color::Black => offset_rank(target.rank(), 1),
    }?;
    Some(Square::new(target.file(), captured_rank))
}

const fn en_passant_attacker_rank(color: Color) -> Rank {
    match color {
        Color::White => Rank::Fifth,
        Color::Black => Rank::Fourth,
    }
}

const fn en_passant_target_rank(color: Color) -> Rank {
    match color {
        Color::White => Rank::Sixth,
        Color::Black => Rank::Third,
    }
}

fn add_pawn_candidate(from: Square, to: Square, moves: &mut Vec<Move>) {
    if is_promotion_rank_transition(from, to) {
        moves.extend(PROMOTION_PIECES.map(|promotion| Move {
            from,
            to,
            promotion: Some(promotion),
        }));
        return;
    }

    moves.push(Move {
        from,
        to,
        promotion: None,
    });
}

fn pawn_forward_rank(color: Color, rank: Rank, steps: i8) -> Option<Rank> {
    let rank_index = rank.index() as i8;
    let next_index = match color {
        Color::White => rank_index.checked_add(steps)?,
        Color::Black => rank_index.checked_sub(steps)?,
    };
    if !(0..8).contains(&next_index) {
        return None;
    }

    Rank::from_index(next_index as usize)
}

const fn pawn_start_rank(color: Color) -> Rank {
    match color {
        Color::White => Rank::Second,
        Color::Black => Rank::Seventh,
    }
}

fn offset_file(file: File, delta: i8) -> Option<File> {
    let file_index = file.index() as i8;
    let next_index = file_index.checked_add(delta)?;
    if !(0..8).contains(&next_index) {
        return None;
    }

    File::from_index(next_index as usize)
}

const KNIGHT_OFFSETS: [(i8, i8); 8] = [
    (-2, -1),
    (-2, 1),
    (-1, -2),
    (-1, 2),
    (1, -2),
    (1, 2),
    (2, -1),
    (2, 1),
];

const KING_OFFSETS: [(i8, i8); 8] = [
    (-1, -1),
    (-1, 0),
    (-1, 1),
    (0, -1),
    (0, 1),
    (1, -1),
    (1, 0),
    (1, 1),
];

/// Occupancy sets with one bit per square (bit `rank * 8 + file`, so a1 is bit 0). Kept in step
/// with `Position::board` by `Position::set_piece`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Bitboards {
    colors: [u64; 2],
    kinds: [u64; 6],
}

impl Bitboards {
    fn scan(board: &[Option<Piece>; BOARD_SQUARES]) -> Self {
        let mut bitboards = Self {
            colors: [0; 2],
            kinds: [0; 6],
        };
        for (index, piece) in board.iter().enumerate() {
            if let Some(piece) = piece {
                bitboards.toggle(*piece, index);
            }
        }
        bitboards
    }

    fn toggle(&mut self, piece: Piece, index: usize) {
        self.colors[piece.color as usize] ^= 1 << index;
        self.kinds[piece.kind as usize] ^= 1 << index;
    }

    fn occupied(&self) -> u64 {
        self.colors[0] | self.colors[1]
    }

    fn pieces(&self, color: Color, kind: PieceKind) -> u64 {
        self.colors[color as usize] & self.kinds[kind as usize]
    }
}

/// Every square by bit index, so a set bit converts back to a [`Square`] without the fallible
/// file/rank lookups.
const SQUARES: [Square; BOARD_SQUARES] = {
    let mut squares = [Square::new(File::A, Rank::First); BOARD_SQUARES];
    let mut index = 0;
    while index < BOARD_SQUARES {
        squares[index] = Square::new(File::ALL[index % 8], Rank::ALL[index / 8]);
        index += 1;
    }
    squares
};

/// Indices of the set bits, lowest first.
fn bit_indices(mut bits: u64) -> impl Iterator<Item = usize> {
    std::iter::from_fn(move || {
        if bits == 0 {
            return None;
        }
        let index = bits.trailing_zeros() as usize;
        bits &= bits - 1;
        Some(index)
    })
}

const fn on_board(file: i8, rank: i8) -> bool {
    file >= 0 && file < 8 && rank >= 0 && rank < 8
}

/// For each square, the squares one `offsets` step away that stay on the board.
const fn leaper_attacks(offsets: &[(i8, i8)]) -> [u64; BOARD_SQUARES] {
    let mut table = [0; BOARD_SQUARES];
    let mut square = 0;
    while square < BOARD_SQUARES {
        let mut i = 0;
        while i < offsets.len() {
            let file = (square % 8) as i8 + offsets[i].0;
            let rank = (square / 8) as i8 + offsets[i].1;
            if on_board(file, rank) {
                table[square] |= 1 << (rank * 8 + file);
            }
            i += 1;
        }
        square += 1;
    }
    table
}

static KNIGHT_ATTACKS: [u64; BOARD_SQUARES] = leaper_attacks(&KNIGHT_OFFSETS);
static KING_ATTACKS: [u64; BOARD_SQUARES] = leaper_attacks(&KING_OFFSETS);
/// `PAWN_ATTACKS[color][square]`: the squares a `color` pawn on `square` attacks.
static PAWN_ATTACKS: [[u64; BOARD_SQUARES]; 2] = [
    leaper_attacks(&[(-1, 1), (1, 1)]),
    leaper_attacks(&[(-1, -1), (1, -1)]),
];
/// `LINE_MASKS[line][square]`: the other squares of the rank, file, diagonal and anti-diagonal
/// through `square`, for [`line_attacks`].
static LINE_MASKS: [[u64; BOARD_SQUARES]; 4] = {
    let mut masks = [[0_u64; BOARD_SQUARES]; 4];
    let mut square = 0;
    while square < BOARD_SQUARES {
        let mut other = 0;
        while other < BOARD_SQUARES {
            if other != square {
                let (file, rank) = ((square % 8) as i8, (square / 8) as i8);
                let (other_file, other_rank) = ((other % 8) as i8, (other / 8) as i8);
                if rank == other_rank {
                    masks[0][square] |= 1 << other;
                }
                if file == other_file {
                    masks[1][square] |= 1 << other;
                }
                if rank - file == other_rank - other_file {
                    masks[2][square] |= 1 << other;
                }
                if rank + file == other_rank + other_file {
                    masks[3][square] |= 1 << other;
                }
            }
            other += 1;
        }
        square += 1;
    }
    masks
};

/// Hyperbola quintessence: the squares reachable from `square` along one line up to and
/// including the first blocker in each direction, with no per-direction loop.
fn line_attacks(line: usize, square: usize, occupied: u64) -> u64 {
    let mask = LINE_MASKS[line][square];
    let blockers = occupied & mask;
    let bit = 1_u64 << square;
    let forward = blockers.wrapping_sub(bit.wrapping_mul(2));
    let backward = blockers
        .reverse_bits()
        .wrapping_sub(bit.reverse_bits().wrapping_mul(2))
        .reverse_bits();
    (forward ^ backward) & mask
}

fn rook_attacks(square: usize, occupied: u64) -> u64 {
    line_attacks(0, square, occupied) | line_attacks(1, square, occupied)
}

fn bishop_attacks(square: usize, occupied: u64) -> u64 {
    line_attacks(2, square, occupied) | line_attacks(3, square, occupied)
}

/// Squares `piece` on `square` attacks given the board occupancy (pawns: captures only).
fn piece_attacks(piece: Piece, square: usize, occupied: u64) -> u64 {
    match piece.kind {
        PieceKind::Pawn => PAWN_ATTACKS[piece.color as usize][square],
        PieceKind::Knight => KNIGHT_ATTACKS[square],
        PieceKind::King => KING_ATTACKS[square],
        PieceKind::Bishop => bishop_attacks(square, occupied),
        PieceKind::Rook => rook_attacks(square, occupied),
        PieceKind::Queen => bishop_attacks(square, occupied) | rook_attacks(square, occupied),
    }
}

pub(crate) fn generate_knight_pseudo_moves(position: &Position, color: Color) -> Vec<Move> {
    let mut moves = Vec::new();
    push_piece_pseudo_moves(position, Piece::new(color, PieceKind::Knight), &mut moves);
    moves
}

pub(crate) fn generate_king_pseudo_moves(position: &Position, color: Color) -> Vec<Move> {
    let mut moves = Vec::new();
    push_piece_pseudo_moves(position, Piece::new(color, PieceKind::King), &mut moves);
    moves
}

pub(crate) fn generate_bishop_pseudo_moves(position: &Position, color: Color) -> Vec<Move> {
    let mut moves = Vec::new();
    push_piece_pseudo_moves(position, Piece::new(color, PieceKind::Bishop), &mut moves);
    moves
}

pub(crate) fn generate_rook_pseudo_moves(position: &Position, color: Color) -> Vec<Move> {
    let mut moves = Vec::new();
    push_piece_pseudo_moves(position, Piece::new(color, PieceKind::Rook), &mut moves);
    moves
}

pub(crate) fn generate_queen_pseudo_moves(position: &Position, color: Color) -> Vec<Move> {
    let mut moves = Vec::new();
    push_piece_pseudo_moves(position, Piece::new(color, PieceKind::Queen), &mut moves);
    moves
}

// Keep the internal M4b helpers lint-clean until later movegen slices consume them.
const _: fn(&Position, Color) -> Vec<Move> = generate_knight_pseudo_moves;
const _: fn(&Position, Color) -> Vec<Move> = generate_king_pseudo_moves;
// Keep the internal M4c helpers lint-clean until later movegen slices consume them.
const _: fn(&Position, Color) -> Vec<Move> = generate_bishop_pseudo_moves;
const _: fn(&Position, Color) -> Vec<Move> = generate_rook_pseudo_moves;
const _: fn(&Position, Color) -> Vec<Move> = generate_queen_pseudo_moves;

/// Pseudo-moves (own-piece targets excluded) for every `piece` on the board; not for pawns.
fn push_piece_pseudo_moves(position: &Position, piece: Piece, moves: &mut Vec<Move>) {
    let own = position.bitboards.colors[piece.color as usize];
    let occupied = position.bitboards.occupied();
    for from in bit_indices(position.bitboards.pieces(piece.color, piece.kind)) {
        let targets = piece_attacks(piece, from, occupied) & !own;
        moves.extend(bit_indices(targets).map(|to| Move {
            from: SQUARES[from],
            to: SQUARES[to],
            promotion: None,
        }));
    }
}

pub(crate) fn is_square_attacked(position: &Position, square: Square, by_color: Color) -> bool {
    let bitboards = &position.bitboards;
    let index = square.index();
    let occupied = bitboards.occupied();
    let attackers = |kind: PieceKind| bitboards.pieces(by_color, kind);
    // A `by_color` pawn attacks `square` exactly when an opposite-colored pawn on `square` would
    // attack the pawn's square.
    PAWN_ATTACKS[by_color.opposite() as usize][index] & attackers(PieceKind::Pawn) != 0
        || KNIGHT_ATTACKS[index] & attackers(PieceKind::Knight) != 0
        || KING_ATTACKS[index] & attackers(PieceKind::King) != 0
        || bishop_attacks(index, occupied)
            & (attackers(PieceKind::Bishop) | attackers(PieceKind::Queen))
            != 0
        || rook_attacks(index, occupied)
            & (attackers(PieceKind::Rook) | attackers(PieceKind::Queen))
            != 0
}

pub(crate) fn is_in_check(position: &Position, color: Color) -> bool {
    king_square(position, color)
        .is_some_and(|king| is_square_attacked(position, king, color.opposite()))
}

/// Typical upper bound for a middlegame move list; avoids regrowing the pseudo-move vector.
const MOVE_LIST_CAPACITY: usize = 64;

/// Returns a predicate that decides whether a normal pseudo-move is legal for the side to move.
///
/// Only king moves, en passant, moves from a square aligned with the king (possible pins) and
/// every move while in check need a real verification on a scratch position. Any other move
/// cannot expose the king, so it is legal by construction.
fn normal_move_legality(position: &Position) -> impl FnMut(Move) -> bool + '_ {
    let color = position.side_to_move();
    let king = king_square(position, color);
    let in_check =
        king.is_some_and(|square| is_square_attacked(position, square, color.opposite()));
    let mut scratch = position.clone();

    move |candidate| {
        let Some(moving_piece) = position.piece_at(candidate.from()) else {
            return false;
        };
        let target_piece = position.piece_at(candidate.to());
        let needs_verification = in_check
            || moving_piece.kind() == PieceKind::King
            || is_pawn_diagonal_to_empty_square(color, moving_piece, candidate, target_piece)
            || king.is_some_and(|square| is_aligned(square, candidate.from()));
        if !needs_verification {
            return moving_piece.color() == color
                && target_piece
                    .is_none_or(|piece| piece.color() != color && piece.kind() != PieceKind::King);
        }

        scratch.clone_from(position);
        make_move_in_place(&mut scratch, candidate).is_some() && !is_in_check(&scratch, color)
    }
}

fn is_aligned(a: Square, b: Square) -> bool {
    let file_distance = a.file().index().abs_diff(b.file().index());
    let rank_distance = a.rank().index().abs_diff(b.rank().index());
    file_distance == 0 || rank_distance == 0 || file_distance == rank_distance
}

pub(crate) fn generate_normal_legal_moves(position: &Position) -> Vec<Move> {
    let mut moves = generate_normal_pseudo_moves(position, position.side_to_move());
    let mut is_legal = normal_move_legality(position);
    moves.retain(|candidate| is_legal(*candidate));
    moves
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BoardStatus {
    Ongoing,
    Checkmate,
    Stalemate,
}

impl From<BoardStatus> for PositionStatus {
    fn from(status: BoardStatus) -> Self {
        match status {
            BoardStatus::Ongoing => Self::Ongoing,
            BoardStatus::Checkmate => Self::Checkmate,
            BoardStatus::Stalemate => Self::Stalemate,
        }
    }
}

pub(crate) fn generate_legal_moves(position: &Position) -> Vec<Move> {
    let mut moves = generate_normal_legal_moves(position);
    moves.extend(generate_castling_moves(position));
    moves
}

fn has_any_legal_move(position: &Position) -> bool {
    let color = position.side_to_move();
    generate_normal_pseudo_moves(position, color)
        .into_iter()
        .any(normal_move_legality(position))
        || !generate_castling_moves(position).is_empty()
}

pub(crate) fn terminal_status(position: &Position) -> BoardStatus {
    if has_any_legal_move(position) {
        return BoardStatus::Ongoing;
    }

    if is_in_check(position, position.side_to_move()) {
        BoardStatus::Checkmate
    } else {
        BoardStatus::Stalemate
    }
}

fn has_insufficient_material(position: &Position) -> bool {
    let kinds = &position.bitboards.kinds;
    if kinds[PieceKind::Pawn as usize]
        | kinds[PieceKind::Rook as usize]
        | kinds[PieceKind::Queen as usize]
        != 0
    {
        return false;
    }
    let mut minor_count = 0_u8;
    let mut bishop_square_color: Option<bool> = None;

    for square in all_squares() {
        let Some(piece) = position.piece_at(square) else {
            continue;
        };
        match piece.kind() {
            PieceKind::King => {}
            PieceKind::Queen | PieceKind::Rook | PieceKind::Pawn => return false,
            PieceKind::Knight => {
                minor_count = minor_count.saturating_add(1);
                if minor_count > 1 {
                    return false;
                }
            }
            PieceKind::Bishop => {
                minor_count = minor_count.saturating_add(1);
                let color = square_is_light(square);
                if let Some(existing) = bishop_square_color {
                    if existing != color {
                        return false;
                    }
                } else {
                    bishop_square_color = Some(color);
                }
            }
        }
    }

    true
}

fn all_squares() -> impl Iterator<Item = Square> {
    Rank::ALL.into_iter().flat_map(|rank| {
        File::ALL
            .into_iter()
            .map(move |file| Square::new(file, rank))
    })
}

fn square_is_light(square: Square) -> bool {
    (square.file().index() + square.rank().index()) % 2 == 1
}

fn perft_nodes(position: &Position, depth: u8) -> Result<u64, LegalMoveError> {
    if depth == 0 {
        return Ok(1);
    }

    let moves = position.legal_moves()?;
    if depth == 1 {
        return u64::try_from(moves.len()).map_err(|_error| LegalMoveError::NodeCountOverflow);
    }

    let mut nodes = 0_u64;
    for mv in moves {
        let mut child = position.clone();
        if make_move_in_place(&mut child, mv).is_none() {
            return Err(LegalMoveError::InvalidPosition);
        }
        let child_nodes = perft_nodes(&child, depth - 1)?;
        nodes = nodes
            .checked_add(child_nodes)
            .ok_or(LegalMoveError::NodeCountOverflow)?;
    }

    Ok(nodes)
}

fn perft_divide(position: &Position, depth: u8) -> Result<Vec<PerftDivideEntry>, LegalMoveError> {
    if depth == 0 {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    for mv in position.legal_moves()? {
        let mut child = position.clone();
        if make_move_in_place(&mut child, mv).is_none() {
            return Err(LegalMoveError::InvalidPosition);
        }
        entries.push(PerftDivideEntry {
            mv,
            nodes: perft_nodes(&child, depth - 1)?,
        });
    }

    Ok(entries)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PositionIssue {
    SideNotToMoveInCheck(Color),
    CastlingRightsWithoutOriginalPieces,
    EnPassantTargetHasNoLegalCapture,
    ImpossibleMaterialCount(Color),
}

impl PositionIssue {
    const fn blocks_legal_moves(self) -> bool {
        matches!(
            self,
            Self::SideNotToMoveInCheck(_) | Self::CastlingRightsWithoutOriginalPieces
        )
    }
}

pub(crate) fn classify_position(position: &Position) -> Vec<PositionIssue> {
    let mut issues = Vec::new();
    let side_not_to_move = position.side_to_move().opposite();
    if is_in_check(position, side_not_to_move) {
        issues.push(PositionIssue::SideNotToMoveInCheck(side_not_to_move));
    }
    if has_castling_rights_without_original_pieces(position) {
        issues.push(PositionIssue::CastlingRightsWithoutOriginalPieces);
    }
    if position
        .en_passant_target()
        .is_some_and(|target| !is_en_passant_target_capturable(position, target))
    {
        issues.push(PositionIssue::EnPassantTargetHasNoLegalCapture);
    }
    for color in [Color::White, Color::Black] {
        if has_impossible_material(position, color) {
            issues.push(PositionIssue::ImpossibleMaterialCount(color));
        }
    }
    issues
}

pub(crate) fn generate_castling_moves(position: &Position) -> Vec<Move> {
    let mut moves = Vec::new();
    add_castling_move(position, CastleSide::Kingside, &mut moves);
    add_castling_move(position, CastleSide::Queenside, &mut moves);
    moves
}

// Keep the internal M5a helpers lint-clean until M5b consumes them.
const _: fn(&Position, Square, Color) -> bool = is_square_attacked;
const _: fn(&Position, Color) -> bool = is_in_check;
// Keep the internal M5b helper lint-clean until later legal move slices consume it.
const _: fn(&Position) -> Vec<Move> = generate_normal_legal_moves;
// Keep the internal M6e helpers lint-clean until public legal move/status slices consume them.
const _: fn(&Position) -> Vec<Move> = generate_legal_moves;
const _: fn(&Position) -> BoardStatus = terminal_status;
// Keep the internal M6e2 classifier lint-clean until public legal move gating consumes it.
const _: fn(&Position) -> Vec<PositionIssue> = classify_position;
// Keep the internal M6a helper lint-clean until later legal move slices consume it.
const _: fn(&Position) -> Vec<Move> = generate_castling_moves;
// Keep the internal M6b helpers lint-clean until later legal move slices consume them.
const _: fn(&mut Position, Move) -> Option<UndoState> = make_reversible_move;
const _: fn(&mut Position, UndoState) = unmake_reversible_move;

#[derive(Clone, Copy)]
enum CastleSide {
    Kingside,
    Queenside,
}

fn add_castling_move(position: &Position, side: CastleSide, moves: &mut Vec<Move>) {
    let color = position.side_to_move();
    if !can_castle(position, color, side) {
        return;
    }
    let (king_from, king_to) = castle_king_squares(color, side);
    if let Ok(candidate) = Move::new(king_from, king_to, None) {
        moves.push(candidate);
    }
}

fn can_castle(position: &Position, color: Color, side: CastleSide) -> bool {
    if !has_castling_right(position.castling_rights(), color, side) {
        return false;
    }

    let (king_from, king_to) = castle_king_squares(color, side);
    let (rook_from, rook_to) = castle_rook_squares(color, side);
    if position.piece_at(king_from) != Some(Piece::new(color, PieceKind::King))
        || position.piece_at(rook_from) != Some(Piece::new(color, PieceKind::Rook))
    {
        return false;
    }

    if position.bitboards.occupied() & castle_empty_mask(color, side) != 0 {
        return false;
    }

    let opponent = color.opposite();
    if is_square_attacked(position, king_from, opponent) {
        return false;
    }

    let transit = castle_transit_square(color, side);
    is_castle_king_square_safe(position, color, king_from, transit, None)
        && is_castle_king_square_safe(
            position,
            color,
            king_from,
            king_to,
            Some((rook_from, rook_to)),
        )
}

fn has_castling_rights_without_original_pieces(position: &Position) -> bool {
    [Color::White, Color::Black].into_iter().any(|color| {
        [CastleSide::Kingside, CastleSide::Queenside]
            .into_iter()
            .any(|side| {
                has_castling_right(position.castling_rights(), color, side)
                    && !has_original_castling_pieces(position, color, side)
            })
    })
}

fn has_original_castling_pieces(position: &Position, color: Color, side: CastleSide) -> bool {
    let (king_from, _) = castle_king_squares(color, side);
    let (rook_from, _) = castle_rook_squares(color, side);
    position.piece_at(king_from) == Some(Piece::new(color, PieceKind::King))
        && position.piece_at(rook_from) == Some(Piece::new(color, PieceKind::Rook))
}

fn is_en_passant_target_capturable(position: &Position, target: Square) -> bool {
    let color = position.side_to_move();
    generate_normal_legal_moves(position)
        .into_iter()
        .any(|candidate| {
            let Some(moving_piece) = position.piece_at(candidate.from()) else {
                return false;
            };
            candidate.to() == target
                && is_pawn_diagonal_to_empty_square(
                    color,
                    moving_piece,
                    candidate,
                    position.piece_at(target),
                )
        })
}

#[derive(Default)]
struct MaterialCount {
    total: usize,
    pawns: usize,
    queens: usize,
    rooks: usize,
    bishops: usize,
    knights: usize,
}

fn has_impossible_material(position: &Position, color: Color) -> bool {
    let mut count = MaterialCount::default();
    for rank in Rank::ALL {
        for file in File::ALL {
            let square = Square::new(file, rank);
            let Some(piece) = position.piece_at(square) else {
                continue;
            };
            if piece.color() != color {
                continue;
            }
            count.total += 1;
            match piece.kind() {
                PieceKind::King => {}
                PieceKind::Queen => count.queens += 1,
                PieceKind::Rook => count.rooks += 1,
                PieceKind::Bishop => count.bishops += 1,
                PieceKind::Knight => count.knights += 1,
                PieceKind::Pawn => count.pawns += 1,
            }
        }
    }

    let promoted_pieces = count.queens.saturating_sub(1)
        + count.rooks.saturating_sub(2)
        + count.bishops.saturating_sub(2)
        + count.knights.saturating_sub(2);
    count.total > 16 || count.pawns > 8 || promoted_pieces > 8_usize.saturating_sub(count.pawns)
}

fn is_castle_king_square_safe(
    position: &Position,
    color: Color,
    king_from: Square,
    king_square: Square,
    rook_move: Option<(Square, Square)>,
) -> bool {
    let mut after = position.clone();
    after.set_piece(king_from, None);
    if let Some((rook_from, rook_to)) = rook_move {
        after.set_piece(rook_from, None);
        after.set_piece(rook_to, Some(Piece::new(color, PieceKind::Rook)));
    }
    after.set_piece(king_square, Some(Piece::new(color, PieceKind::King)));

    !is_square_attacked(&after, king_square, color.opposite())
}

fn has_castling_right(rights: CastlingRights, color: Color, side: CastleSide) -> bool {
    match (color, side) {
        (Color::White, CastleSide::Kingside) => rights.white_kingside(),
        (Color::White, CastleSide::Queenside) => rights.white_queenside(),
        (Color::Black, CastleSide::Kingside) => rights.black_kingside(),
        (Color::Black, CastleSide::Queenside) => rights.black_queenside(),
    }
}

fn castle_king_squares(color: Color, side: CastleSide) -> (Square, Square) {
    let rank = back_rank(color);
    let to_file = match side {
        CastleSide::Kingside => File::G,
        CastleSide::Queenside => File::C,
    };
    (Square::new(File::E, rank), Square::new(to_file, rank))
}

fn castle_rook_squares(color: Color, side: CastleSide) -> (Square, Square) {
    let rank = back_rank(color);
    match side {
        CastleSide::Kingside => (Square::new(File::H, rank), Square::new(File::F, rank)),
        CastleSide::Queenside => (Square::new(File::A, rank), Square::new(File::D, rank)),
    }
}

fn castle_transit_square(color: Color, side: CastleSide) -> Square {
    let rank = back_rank(color);
    let file = match side {
        CastleSide::Kingside => File::F,
        CastleSide::Queenside => File::D,
    };
    Square::new(file, rank)
}

/// Squares between king and rook that must be empty to castle.
fn castle_empty_mask(color: Color, side: CastleSide) -> u64 {
    let rank_shift = match color {
        Color::White => 0,
        Color::Black => 56,
    };
    let files: u64 = match side {
        CastleSide::Kingside => 0b0110_0000,
        CastleSide::Queenside => 0b0000_1110,
    };
    files << rank_shift
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct UndoState {
    previous: BoardState,
}

pub(crate) fn make_reversible_move(position: &mut Position, candidate: Move) -> Option<UndoState> {
    let previous = position.board_state();
    make_move_in_place(position, candidate)?;
    Some(UndoState { previous })
}

/// Applies `candidate` in place without building undo state. All validation runs before any
/// mutation, so on `None` the position is unchanged. This is the single move-application core:
/// [`make_reversible_move`] wraps it, and the legality filter, child builders and perft walkers
/// (which never use the undo state) call it directly to avoid the extra `Position` clone.
pub(crate) fn make_move_in_place(position: &mut Position, candidate: Move) -> Option<()> {
    let color = position.side_to_move();
    let moving_piece = position.piece_at(candidate.from())?;
    if moving_piece.color() != color {
        return None;
    }

    let target_piece = position.piece_at(candidate.to());
    if target_piece.is_some_and(|piece| piece.color() == color || piece.kind() == PieceKind::King) {
        return None;
    }
    let en_passant_capture_square =
        en_passant_capture_square(position, color, moving_piece, candidate, target_piece)?;
    let captured_piece = if let Some(square) = en_passant_capture_square {
        Some(position.piece_at(square)?)
    } else {
        target_piece
    };
    let placed_piece = piece_after_promotion(candidate, moving_piece, captured_piece)?;

    let castle_side = castle_side_for_move(color, moving_piece, candidate);
    if let Some(side) = castle_side {
        if !can_castle(position, color, side) {
            return None;
        }
    }

    apply_move(
        position,
        candidate,
        &AppliedMove {
            moving_piece,
            placed_piece,
            captured_piece,
            en_passant_capture_square,
            castle_side,
        },
    );
    Some(())
}

/// What a move does to the board, already decided and validated by the caller.
struct AppliedMove {
    moving_piece: Piece,
    placed_piece: Piece,
    captured_piece: Option<Piece>,
    en_passant_capture_square: Option<Square>,
    castle_side: Option<CastleSide>,
}

fn apply_move(position: &mut Position, candidate: Move, applied: &AppliedMove) {
    let color = position.side_to_move();
    let old_state_hash = zobrist_state_hash(position);
    position.set_piece(candidate.from(), None);
    if let Some(square) = applied.en_passant_capture_square {
        position.set_piece(square, None);
    }
    if let Some(side) = applied.castle_side {
        let (rook_from, rook_to) = castle_rook_squares(color, side);
        position.set_piece(rook_from, None);
        position.set_piece(rook_to, Some(Piece::new(color, PieceKind::Rook)));
    }
    position.set_piece(candidate.to(), Some(applied.placed_piece));

    update_castling_rights(
        position,
        color,
        applied.moving_piece,
        candidate,
        applied.captured_piece,
        applied.castle_side,
    );
    update_counters_and_en_passant(
        position,
        color,
        applied.moving_piece,
        candidate,
        applied.captured_piece,
    );
    position.side_to_move = color.opposite();
    position.hash ^= old_state_hash ^ zobrist_state_hash(position);
}

/// [`make_move_in_place`] for a move taken from the pseudo-legal generator of this exact
/// position: the generator already guarantees piece ownership, targets, promotion geometry and
/// castling legality, so none of that is re-derived. Does not check the mover's own king safety.
fn make_generated_move(position: &mut Position, candidate: Move) {
    let color = position.side_to_move();
    let Some(moving_piece) = position.piece_at(candidate.from()) else {
        return;
    };
    let target_piece = position.piece_at(candidate.to());
    let is_en_passant = moving_piece.kind() == PieceKind::Pawn
        && target_piece.is_none()
        && candidate.from().file() != candidate.to().file();
    let en_passant_capture_square =
        is_en_passant.then(|| Square::new(candidate.to().file(), candidate.from().rank()));
    let captured_piece = match en_passant_capture_square {
        Some(square) => position.piece_at(square),
        None => target_piece,
    };
    let placed_piece = match candidate.promotion() {
        Some(promotion) => Piece::new(color, promotion_piece_kind(promotion)),
        None => moving_piece,
    };
    apply_move(
        position,
        candidate,
        &AppliedMove {
            moving_piece,
            placed_piece,
            captured_piece,
            en_passant_capture_square,
            castle_side: castle_side_for_move(color, moving_piece, candidate),
        },
    );
}

pub(crate) fn unmake_reversible_move(position: &mut Position, undo: UndoState) {
    position.restore_board_state(undo.previous);
}

fn castle_side_for_move(color: Color, piece: Piece, candidate: Move) -> Option<CastleSide> {
    if piece != Piece::new(color, PieceKind::King) {
        return None;
    }

    let (kingside_from, kingside_to) = castle_king_squares(color, CastleSide::Kingside);
    let (queenside_from, queenside_to) = castle_king_squares(color, CastleSide::Queenside);
    if candidate.from() == kingside_from && candidate.to() == kingside_to {
        Some(CastleSide::Kingside)
    } else if candidate.from() == queenside_from && candidate.to() == queenside_to {
        Some(CastleSide::Queenside)
    } else {
        None
    }
}

fn piece_after_promotion(
    candidate: Move,
    moving_piece: Piece,
    captured_piece: Option<Piece>,
) -> Option<Piece> {
    match candidate.promotion() {
        Some(promotion) if is_valid_promotion(candidate, moving_piece, captured_piece) => Some(
            Piece::new(moving_piece.color(), promotion_piece_kind(promotion)),
        ),
        Some(_) => None,
        None if moving_piece.kind() == PieceKind::Pawn
            && is_promotion_target_rank(moving_piece.color(), candidate.to().rank()) =>
        {
            None
        }
        None => Some(moving_piece),
    }
}

fn en_passant_capture_square(
    position: &Position,
    color: Color,
    moving_piece: Piece,
    candidate: Move,
    target_piece: Option<Piece>,
) -> Option<Option<Square>> {
    if !is_pawn_diagonal_to_empty_square(color, moving_piece, candidate, target_piece) {
        return Some(None);
    }
    if !is_valid_en_passant(position, color, candidate.from(), candidate.to()) {
        return None;
    }
    en_passant_captured_square(color, candidate.to()).map(Some)
}

fn is_pawn_diagonal_to_empty_square(
    color: Color,
    moving_piece: Piece,
    candidate: Move,
    target_piece: Option<Piece>,
) -> bool {
    moving_piece.kind() == PieceKind::Pawn
        && target_piece.is_none()
        && candidate.promotion().is_none()
        && candidate
            .from()
            .file()
            .index()
            .abs_diff(candidate.to().file().index())
            == 1
        && pawn_forward_rank(color, candidate.from().rank(), 1) == Some(candidate.to().rank())
}

fn is_valid_promotion(candidate: Move, moving_piece: Piece, captured_piece: Option<Piece>) -> bool {
    moving_piece.kind() == PieceKind::Pawn
        && is_promotion_source_rank(moving_piece.color(), candidate.from().rank())
        && is_promotion_target_rank(moving_piece.color(), candidate.to().rank())
        && is_valid_promotion_geometry(candidate, captured_piece)
}

fn is_valid_promotion_geometry(candidate: Move, captured_piece: Option<Piece>) -> bool {
    match (
        candidate
            .from()
            .file()
            .index()
            .abs_diff(candidate.to().file().index()),
        captured_piece,
    ) {
        (0, None) | (1, Some(_)) => true,
        (_, _) => false,
    }
}

const fn is_promotion_source_rank(color: Color, rank: Rank) -> bool {
    match color {
        Color::White => matches!(rank, Rank::Seventh),
        Color::Black => matches!(rank, Rank::Second),
    }
}

const fn is_promotion_target_rank(color: Color, rank: Rank) -> bool {
    match color {
        Color::White => matches!(rank, Rank::Eighth),
        Color::Black => matches!(rank, Rank::First),
    }
}

fn update_castling_rights(
    position: &mut Position,
    color: Color,
    moving_piece: Piece,
    candidate: Move,
    captured_piece: Option<Piece>,
    castle_side: Option<CastleSide>,
) {
    if moving_piece.kind() == PieceKind::King || castle_side.is_some() {
        clear_castling_rights_for_color(&mut position.castling_rights, color);
    }
    if moving_piece == Piece::new(color, PieceKind::Rook) {
        clear_rook_origin_castling_right(&mut position.castling_rights, color, candidate.from());
    }
    if let Some(captured) = captured_piece {
        if captured.kind() == PieceKind::Rook {
            clear_rook_origin_castling_right(
                &mut position.castling_rights,
                captured.color(),
                candidate.to(),
            );
        }
    }
}

fn clear_castling_rights_for_color(rights: &mut CastlingRights, color: Color) {
    match color {
        Color::White => {
            rights.white_kingside = false;
            rights.white_queenside = false;
        }
        Color::Black => {
            rights.black_kingside = false;
            rights.black_queenside = false;
        }
    }
}

fn clear_rook_origin_castling_right(rights: &mut CastlingRights, color: Color, square: Square) {
    match (color, square.file(), square.rank()) {
        (Color::White, File::H, Rank::First) => rights.white_kingside = false,
        (Color::White, File::A, Rank::First) => rights.white_queenside = false,
        (Color::Black, File::H, Rank::Eighth) => rights.black_kingside = false,
        (Color::Black, File::A, Rank::Eighth) => rights.black_queenside = false,
        _ => {}
    }
}

fn update_counters_and_en_passant(
    position: &mut Position,
    color: Color,
    moving_piece: Piece,
    candidate: Move,
    captured_piece: Option<Piece>,
) {
    if moving_piece.kind() == PieceKind::Pawn || captured_piece.is_some() {
        position.halfmove_clock = 0;
    } else {
        position.halfmove_clock = position.halfmove_clock.saturating_add(1);
    }

    position.en_passant_target =
        capturable_double_pawn_push_target(position, color, moving_piece, candidate);
    if color == Color::Black {
        position.fullmove_number = position.fullmove_number.saturating_add(1);
    }
}

fn capturable_double_pawn_push_target(
    position: &Position,
    color: Color,
    piece: Piece,
    candidate: Move,
) -> Option<Square> {
    let target = double_pawn_push_target(piece, candidate)?;
    is_en_passant_target_legally_capturable_by(position, color.opposite(), target).then_some(target)
}

fn double_pawn_push_target(piece: Piece, candidate: Move) -> Option<Square> {
    if piece.kind() != PieceKind::Pawn || candidate.from().file() != candidate.to().file() {
        return None;
    }

    let from_rank = candidate.from().rank().index();
    let to_rank = candidate.to().rank().index();
    if from_rank.abs_diff(to_rank) != 2 {
        return None;
    }

    Rank::from_index((from_rank + to_rank) / 2)
        .map(|rank| Square::new(candidate.from().file(), rank))
}

fn is_en_passant_target_legally_capturable_by(
    position: &Position,
    color: Color,
    target: Square,
) -> bool {
    en_passant_source_squares(color, target)
        .into_iter()
        .flatten()
        .any(|source| is_legal_en_passant_capture_from(position, color, source, target))
}

fn en_passant_source_squares(color: Color, target: Square) -> [Option<Square>; 2] {
    let Some(source_rank) = Rank::ALL
        .into_iter()
        .find(|rank| pawn_forward_rank(color, *rank, 1) == Some(target.rank()))
    else {
        return [None, None];
    };

    let target_file = target.file().index();
    [
        target_file
            .checked_sub(1)
            .and_then(File::from_index)
            .map(|file| Square::new(file, source_rank)),
        File::from_index(target_file + 1).map(|file| Square::new(file, source_rank)),
    ]
}

fn is_legal_en_passant_capture_from(
    position: &Position,
    color: Color,
    source: Square,
    target: Square,
) -> bool {
    if position.piece_at(source) != Some(Piece::new(color, PieceKind::Pawn)) {
        return false;
    }

    let Ok(candidate) = Move::new(source, target, None) else {
        return false;
    };
    let mut probe = position.clone();
    probe.hash ^= zobrist_state_hash(&probe);
    probe.side_to_move = color;
    probe.en_passant_target = Some(target);
    probe.hash ^= zobrist_state_hash(&probe);

    make_move_in_place(&mut probe, candidate).is_some_and(|()| !is_in_check(&probe, color))
}

const fn back_rank(color: Color) -> Rank {
    match color {
        Color::White => Rank::First,
        Color::Black => Rank::Eighth,
    }
}

fn generate_normal_pseudo_moves(position: &Position, color: Color) -> Vec<Move> {
    let mut moves = Vec::with_capacity(MOVE_LIST_CAPACITY);
    push_pawn_pseudo_moves(position, color, &mut moves);
    for kind in [
        PieceKind::Knight,
        PieceKind::King,
        PieceKind::Bishop,
        PieceKind::Rook,
        PieceKind::Queen,
    ] {
        push_piece_pseudo_moves(position, Piece::new(color, kind), &mut moves);
    }
    moves
}

/// Pseudo-legal moves for the side to move into `out`, appended. With `captures_only`: captures,
/// en passant and queen promotions (capturing or not).
fn generate_pseudo_moves(position: &Position, captures_only: bool, out: &mut MoveList) {
    let color = position.side_to_move;
    let bitboards = &position.bitboards;
    let own = bitboards.colors[color as usize];
    let occupied = bitboards.occupied();
    // Enemy kings are never targets: a position where one is attackable is not a valid position.
    let enemy = bitboards.colors[color.opposite() as usize]
        & !bitboards.pieces(color.opposite(), PieceKind::King);
    let targets = if captures_only {
        enemy
    } else {
        !own & !bitboards.pieces(color.opposite(), PieceKind::King)
    };

    for kind in [
        PieceKind::Knight,
        PieceKind::Bishop,
        PieceKind::Rook,
        PieceKind::Queen,
        PieceKind::King,
    ] {
        let piece = Piece::new(color, kind);
        for from in bit_indices(bitboards.pieces(color, kind)) {
            for to in bit_indices(piece_attacks(piece, from, occupied) & targets) {
                out.push(Move {
                    from: SQUARES[from],
                    to: SQUARES[to],
                    promotion: None,
                });
            }
        }
    }

    generate_pawn_moves(position, color, enemy, captures_only, out);

    if !captures_only {
        for side in [CastleSide::Kingside, CastleSide::Queenside] {
            if can_castle(position, color, side) {
                let (king_from, king_to) = castle_king_squares(color, side);
                out.push(Move {
                    from: king_from,
                    to: king_to,
                    promotion: None,
                });
            }
        }
    }
}

fn generate_pawn_moves(
    position: &Position,
    color: Color,
    enemy: u64,
    captures_only: bool,
    out: &mut MoveList,
) {
    let occupied = position.bitboards.occupied();
    let (promotion_from_rank, start_rank) = match color {
        Color::White => (6, 1),
        Color::Black => (1, 6),
    };
    let push = |from: usize, to: usize, promotion_from: bool, out: &mut MoveList| {
        if promotion_from {
            let promotions: &[PromotionPiece] = if captures_only {
                &PROMOTION_PIECES[..1]
            } else {
                &PROMOTION_PIECES
            };
            for &promotion in promotions {
                out.push(Move {
                    from: SQUARES[from],
                    to: SQUARES[to],
                    promotion: Some(promotion),
                });
            }
        } else {
            out.push(Move {
                from: SQUARES[from],
                to: SQUARES[to],
                promotion: None,
            });
        }
    };

    for from in bit_indices(position.bitboards.pieces(color, PieceKind::Pawn)) {
        let rank = from / 8;
        let promoting = rank == promotion_from_rank;
        let one_step = match color {
            Color::White => from + 8,
            Color::Black => from.wrapping_sub(8),
        };
        // A pawn on its last rank cannot exist in a valid position, so `one_step` is on board.
        if one_step < BOARD_SQUARES && occupied & (1 << one_step) == 0 {
            if promoting || !captures_only {
                push(from, one_step, promoting, out);
            }
            if !captures_only && rank == start_rank {
                let two_step = match color {
                    Color::White => from + 16,
                    Color::Black => from - 16,
                };
                if occupied & (1 << two_step) == 0 {
                    push(from, two_step, false, out);
                }
            }
        }

        let attacks = PAWN_ATTACKS[color as usize][from];
        for to in bit_indices(attacks & enemy) {
            push(from, to, promoting, out);
        }
        if let Some(target) = position.en_passant_target {
            if attacks & (1 << target.index()) != 0
                && is_valid_en_passant(position, color, SQUARES[from], target)
            {
                push(from, target.index(), false, out);
            }
        }
    }
}

const fn promotion_piece_kind(promotion: PromotionPiece) -> PieceKind {
    match promotion {
        PromotionPiece::Queen => PieceKind::Queen,
        PromotionPiece::Rook => PieceKind::Rook,
        PromotionPiece::Bishop => PieceKind::Bishop,
        PromotionPiece::Knight => PieceKind::Knight,
    }
}

fn king_square(position: &Position, color: Color) -> Option<Square> {
    debug_assert_eq!(position.bitboards, Bitboards::scan(&position.board));
    let kings = position.bitboards.pieces(color, PieceKind::King);
    (kings != 0).then(|| SQUARES[kings.trailing_zeros() as usize])
}

fn offset_rank(rank: Rank, delta: i8) -> Option<Rank> {
    let rank_index = rank.index() as i8;
    let next_index = rank_index.checked_add(delta)?;
    if !(0..8).contains(&next_index) {
        return None;
    }

    Rank::from_index(next_index as usize)
}

#[cfg(test)]
mod pawn_pseudo_tests {
    use super::*;
    use std::collections::BTreeSet;

    fn position(fen: &str) -> Position {
        Position::from_fen(fen).expect("test FEN must parse")
    }

    fn square(algebraic: &str) -> Square {
        Square::from_algebraic(algebraic).expect("test square must parse")
    }

    fn pawn_move_set(position: &Position, color: Color) -> BTreeSet<String> {
        let coordinates = generate_pawn_pseudo_moves(position, color)
            .into_iter()
            .map(|candidate| candidate.to_coordinate())
            .collect::<Vec<_>>();
        let unique = coordinates.iter().cloned().collect::<BTreeSet<_>>();

        assert_eq!(
            coordinates.len(),
            unique.len(),
            "pawn pseudo-generation must not emit duplicate coordinates"
        );

        unique
    }

    fn expected(coordinates: &[&str]) -> BTreeSet<String> {
        coordinates
            .iter()
            .map(|coordinate| (*coordinate).to_string())
            .collect()
    }

    #[test]
    fn pawn_quiet_and_double_pushes_are_color_explicit() {
        let position = position("4k3/3p3p/8/8/8/8/P3P3/4K3 b - - 0 1");

        assert_eq!(
            pawn_move_set(&position, Color::White),
            expected(&["a2a3", "a2a4", "e2e3", "e2e4"])
        );
        assert_eq!(
            pawn_move_set(&position, Color::Black),
            expected(&["d7d6", "d7d5", "h7h6", "h7h5"])
        );
    }

    #[test]
    fn pawn_pushes_require_empty_path() {
        let white = position("4k3/8/8/8/1n6/N7/PP2P3/4K3 w - - 0 1");
        let black = position("4k3/4p1pp/7n/6B1/8/8/8/4K3 b - - 0 1");

        assert_eq!(
            pawn_move_set(&white, Color::White),
            expected(&["b2b3", "e2e3", "e2e4"])
        );
        assert_eq!(
            pawn_move_set(&black, Color::Black),
            expected(&["e7e6", "e7e5", "g7g6"])
        );
    }

    #[test]
    fn pawn_captures_enemy_pieces_without_own_capture_or_edge_wraparound() {
        let white = position("4k3/8/8/1n1n1Bn1/P3P2P/8/8/4K3 w - - 0 1");
        let black = position("4k3/8/8/p3p2p/1N1N1bN1/8/8/4K3 b - - 0 1");

        assert_eq!(
            pawn_move_set(&white, Color::White),
            expected(&["a4a5", "a4b5", "e4e5", "e4d5", "h4h5", "h4g5"])
        );
        assert_eq!(
            pawn_move_set(&black, Color::Black),
            expected(&["a5a4", "a5b4", "e5e4", "e5d4", "h5h4", "h5g4"])
        );
    }

    #[test]
    fn pawn_promotions_generate_exact_quiet_and_capture_candidates() {
        let white = position("k2r1r2/4P3/8/8/8/8/8/4K3 w - - 0 1");
        let black = position("4k3/8/8/8/8/8/4p3/K2R1R2 b - - 0 1");

        assert_eq!(
            pawn_move_set(&white, Color::White),
            expected(&[
                "e7e8q", "e7e8r", "e7e8b", "e7e8n", "e7d8q", "e7d8r", "e7d8b", "e7d8n", "e7f8q",
                "e7f8r", "e7f8b", "e7f8n",
            ])
        );
        assert_eq!(
            pawn_move_set(&black, Color::Black),
            expected(&[
                "e2e1q", "e2e1r", "e2e1b", "e2e1n", "e2d1q", "e2d1r", "e2d1b", "e2d1n", "e2f1q",
                "e2f1r", "e2f1b", "e2f1n",
            ])
        );
    }

    #[test]
    fn pawn_en_passant_generation_requires_attacker_target_and_captured_pawn() {
        let white = position("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1");
        let black = position("4k3/8/8/8/3pP3/8/8/4K3 b - e3 0 1");

        assert_eq!(
            pawn_move_set(&white, Color::White),
            expected(&["e5e6", "e5d6"])
        );
        assert_eq!(
            pawn_move_set(&black, Color::Black),
            expected(&["d4d3", "d4e3"])
        );
    }

    #[test]
    fn pawn_en_passant_generation_rejects_stale_or_inconsistent_targets() {
        let no_attacker = position("4k3/8/8/3p4/8/8/8/4K3 w - d6 0 1");
        let empty_captured_square = position("4k3/8/8/4P3/8/8/8/4K3 w - d6 0 1");
        let wrong_color_captured = position("4k3/8/8/3PP3/8/8/8/4K3 w - d6 0 1");
        let occupied_target = position("4k3/8/3n4/3pP3/8/8/8/4K3 w - d6 0 1");
        let mut wrong_target_rank = position("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1");
        wrong_target_rank.en_passant_target = Some(square("d3"));

        assert_eq!(pawn_move_set(&no_attacker, Color::White), expected(&[]));
        assert_eq!(
            pawn_move_set(&empty_captured_square, Color::White),
            expected(&["e5e6"])
        );
        assert_eq!(
            pawn_move_set(&wrong_color_captured, Color::White),
            expected(&["d5d6", "e5e6"])
        );
        assert_eq!(
            pawn_move_set(&occupied_target, Color::White),
            expected(&["e5e6", "e5d6"])
        );
        assert_eq!(
            pawn_move_set(&wrong_target_rank, Color::White),
            expected(&["e5e6"])
        );
    }
}

#[cfg(test)]
mod knight_king_pseudo_tests {
    use super::*;
    use std::collections::BTreeSet;

    fn position(fen: &str) -> Position {
        Position::from_fen(fen).expect("test FEN must parse")
    }

    fn knight_move_set(position: &Position, color: Color) -> BTreeSet<String> {
        let coordinates = generate_knight_pseudo_moves(position, color)
            .into_iter()
            .map(|candidate| candidate.to_coordinate())
            .collect::<Vec<_>>();
        unique_coordinates(coordinates, "knight")
    }

    fn king_move_set(position: &Position, color: Color) -> BTreeSet<String> {
        let coordinates = generate_king_pseudo_moves(position, color)
            .into_iter()
            .map(|candidate| candidate.to_coordinate())
            .collect::<Vec<_>>();
        unique_coordinates(coordinates, "king")
    }

    fn unique_coordinates(piece: Vec<String>, label: &str) -> BTreeSet<String> {
        let unique = piece.iter().cloned().collect::<BTreeSet<_>>();
        assert_eq!(
            piece.len(),
            unique.len(),
            "{label} pseudo-generation must not emit duplicate coordinates"
        );
        unique
    }

    fn expected(coordinates: &[&str]) -> BTreeSet<String> {
        coordinates
            .iter()
            .map(|coordinate| (*coordinate).to_string())
            .collect()
    }

    #[test]
    fn knight_startpos_moves_are_color_explicit() {
        let position = Position::startpos();

        assert_eq!(
            knight_move_set(&position, Color::White),
            expected(&["b1a3", "b1c3", "g1f3", "g1h3"])
        );
        assert_eq!(
            knight_move_set(&position, Color::Black),
            expected(&["b8a6", "b8c6", "g8f6", "g8h6"])
        );
    }

    #[test]
    fn knight_corner_moves_do_not_wrap() {
        let white = position("4k3/8/8/8/8/8/8/N3K3 w - - 0 1");
        let black = position("7n/8/8/8/8/8/8/4K2k b - - 0 1");

        assert_eq!(
            knight_move_set(&white, Color::White),
            expected(&["a1b3", "a1c2"])
        );
        assert_eq!(
            knight_move_set(&black, Color::Black),
            expected(&["h8f7", "h8g6"])
        );
    }

    #[test]
    fn knight_pseudo_moves_exclude_own_pieces_and_capture_enemies() {
        let position = position("4k3/8/2r1r3/1B3B2/3N4/1r3r2/2B5/4K3 w - - 0 1");

        assert_eq!(
            knight_move_set(&position, Color::White),
            expected(&["d4b3", "d4c6", "d4e2", "d4e6", "d4f3"])
        );
    }

    #[test]
    fn king_center_moves_exclude_own_pieces_and_capture_enemies_without_attack_filtering() {
        let position = position("8/8/8/8/4k3/3r1r2/3BKB2/3rBr2 w - - 0 1");

        assert_eq!(
            king_move_set(&position, Color::White),
            expected(&["e2d1", "e2d3", "e2e3", "e2f1", "e2f3"])
        );
    }

    #[test]
    fn king_edge_and_corner_moves_do_not_wrap() {
        let white_edge = position("7k/8/8/8/K7/8/8/8 w - - 0 1");
        let black_corner = position("7k/8/8/8/8/8/8/4K3 b - - 0 1");

        assert_eq!(
            king_move_set(&white_edge, Color::White),
            expected(&["a4a3", "a4a5", "a4b3", "a4b4", "a4b5"])
        );
        assert_eq!(
            king_move_set(&black_corner, Color::Black),
            expected(&["h8g7", "h8g8", "h8h7"])
        );
    }
}

#[cfg(test)]
mod slider_pseudo_tests {
    use super::*;
    use std::collections::BTreeSet;

    fn position(fen: &str) -> Position {
        Position::from_fen(fen).expect("test FEN must parse")
    }

    fn bishop_move_set(position: &Position, color: Color) -> BTreeSet<String> {
        let coordinates = generate_bishop_pseudo_moves(position, color)
            .into_iter()
            .map(|candidate| candidate.to_coordinate())
            .collect::<Vec<_>>();
        unique_coordinates(coordinates, "bishop")
    }

    fn rook_move_set(position: &Position, color: Color) -> BTreeSet<String> {
        let coordinates = generate_rook_pseudo_moves(position, color)
            .into_iter()
            .map(|candidate| candidate.to_coordinate())
            .collect::<Vec<_>>();
        unique_coordinates(coordinates, "rook")
    }

    fn queen_move_set(position: &Position, color: Color) -> BTreeSet<String> {
        let coordinates = generate_queen_pseudo_moves(position, color)
            .into_iter()
            .map(|candidate| candidate.to_coordinate())
            .collect::<Vec<_>>();
        unique_coordinates(coordinates, "queen")
    }

    fn unique_coordinates(piece: Vec<String>, label: &str) -> BTreeSet<String> {
        let unique = piece.iter().cloned().collect::<BTreeSet<_>>();
        assert_eq!(
            piece.len(),
            unique.len(),
            "{label} pseudo-generation must not emit duplicate coordinates"
        );
        unique
    }

    fn expected(coordinates: &[&str]) -> BTreeSet<String> {
        coordinates
            .iter()
            .map(|coordinate| (*coordinate).to_string())
            .collect()
    }

    #[test]
    fn bishop_rays_stop_on_own_blockers_and_include_enemy_capture() {
        let position = position("4k3/r5r1/8/8/3B4/8/5N2/4K3 w - - 0 1");

        assert_eq!(
            bishop_move_set(&position, Color::White),
            expected(&[
                "d4c3", "d4b2", "d4a1", "d4e3", "d4c5", "d4b6", "d4a7", "d4e5", "d4f6", "d4g7",
            ])
        );
    }

    #[test]
    fn rook_rays_stop_on_own_blockers_and_include_enemy_capture() {
        let position = position("4k3/4r3/8/1r1R3B/8/3B4/3r4/4K3 w - - 0 1");

        assert_eq!(
            rook_move_set(&position, Color::White),
            expected(&[
                "d5d6", "d5d7", "d5d8", "d5d4", "d5c5", "d5b5", "d5e5", "d5f5", "d5g5",
            ])
        );
    }

    #[test]
    fn queen_combines_bishop_and_rook_rays() {
        let position = position("4k3/1r1r4/8/1B1Q3r/8/1r3B2/3r4/4K3 w - - 0 1");

        assert_eq!(
            queen_move_set(&position, Color::White),
            expected(&[
                "d5c4", "d5b3", "d5e4", "d5c6", "d5b7", "d5e6", "d5f7", "d5g8", "d5d6", "d5d7",
                "d5d4", "d5d3", "d5d2", "d5c5", "d5e5", "d5f5", "d5g5", "d5h5",
            ])
        );
    }

    #[test]
    fn slider_corner_rays_do_not_wrap() {
        let position = position("4k2q/8/8/8/8/8/8/B3K2R w - - 0 1");

        assert_eq!(
            bishop_move_set(&position, Color::White),
            expected(&["a1b2", "a1c3", "a1d4", "a1e5", "a1f6", "a1g7", "a1h8"])
        );
        assert_eq!(
            rook_move_set(&position, Color::White),
            expected(&[
                "h1h2", "h1h3", "h1h4", "h1h5", "h1h6", "h1h7", "h1h8", "h1g1", "h1f1"
            ])
        );
        assert_eq!(
            queen_move_set(&position, Color::Black),
            expected(&[
                "h8g7", "h8f6", "h8e5", "h8d4", "h8c3", "h8b2", "h8a1", "h8h7", "h8h6", "h8h5",
                "h8h4", "h8h3", "h8h2", "h8h1", "h8g8", "h8f8",
            ])
        );
    }
}

#[cfg(test)]
mod attack_detection_tests {
    use super::*;

    fn position(fen: &str) -> Position {
        Position::from_fen(fen).expect("test FEN must parse")
    }

    fn square(coordinate: &str) -> Square {
        Square::from_algebraic(coordinate).expect("test square must parse")
    }

    #[test]
    fn pawn_attacks_are_directional_empty_and_edge_safe() {
        let position = position("4k3/8/p1p5/8/8/3P3P/8/4K3 w - - 0 1");

        assert!(is_square_attacked(&position, square("c4"), Color::White));
        assert!(is_square_attacked(&position, square("e4"), Color::White));
        assert!(is_square_attacked(&position, square("g4"), Color::White));
        assert!(!is_square_attacked(&position, square("h4"), Color::White));

        assert!(is_square_attacked(&position, square("b5"), Color::Black));
        assert!(is_square_attacked(&position, square("d5"), Color::Black));
        assert!(!is_square_attacked(&position, square("a5"), Color::Black));
    }

    #[test]
    fn leaper_attacks_ignore_target_occupancy() {
        let position = position("7k/8/2r1r3/1B3B2/3N4/1r3r2/4P3/4K3 w - - 0 1");

        for attacked in ["b3", "b5", "c2", "c6", "e2", "e6", "f3", "f5"] {
            assert!(is_square_attacked(
                &position,
                square(attacked),
                Color::White
            ));
        }
        assert!(!is_square_attacked(&position, square("d6"), Color::White));

        assert!(is_square_attacked(&position, square("d1"), Color::White));
        assert!(is_square_attacked(&position, square("e2"), Color::White));
        assert!(is_square_attacked(&position, square("f2"), Color::White));
    }

    #[test]
    fn slider_attacks_stop_at_first_occupied_square() {
        let position = position("4k3/7r/5N2/8/q2B3q/8/3R4/4K3 w - - 0 1");

        assert!(is_square_attacked(&position, square("f6"), Color::White));
        assert!(!is_square_attacked(&position, square("g7"), Color::White));
        assert!(is_square_attacked(&position, square("d4"), Color::White));
        assert!(!is_square_attacked(&position, square("d6"), Color::White));

        assert!(is_square_attacked(&position, square("a1"), Color::Black));
        assert!(is_square_attacked(&position, square("h1"), Color::Black));
        assert!(is_square_attacked(&position, square("d4"), Color::Black));
        assert!(!is_square_attacked(&position, square("e6"), Color::Black));
    }

    #[test]
    fn check_detection_uses_enemy_attacks_without_mutating_position() {
        let position = position("4r1k1/8/8/8/8/8/8/4K3 w - - 0 1");
        let original = position.to_fen();

        assert!(is_in_check(&position, Color::White));
        assert!(!is_in_check(&position, Color::Black));
        assert_eq!(position.to_fen(), original);
    }

    #[test]
    fn is_check_reports_the_side_to_move_status() {
        assert!(position("4r1k1/8/8/8/8/8/8/4K3 w - - 0 1").is_check());
        assert!(!position("4r1k1/8/8/8/8/8/8/4K3 b - - 0 1").is_check());
    }

    #[test]
    fn is_capture_detects_occupied_destination() {
        let position = position("4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1");
        let capture = Move::from_coordinate("e4d5").expect("coordinate must parse");
        let advance = Move::from_coordinate("e4e5").expect("coordinate must parse");
        assert!(position.is_capture(capture));
        assert!(!position.is_capture(advance));
    }

    #[test]
    fn is_capture_detects_en_passant() {
        let position = position("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1");
        let en_passant = Move::from_coordinate("e5d6").expect("coordinate must parse");
        assert!(position.is_capture(en_passant));
    }
}

#[cfg(test)]
mod normal_legal_tests {
    use super::*;
    use std::collections::BTreeSet;

    fn position(fen: &str) -> Position {
        Position::from_fen(fen).expect("test FEN must parse")
    }

    fn legal_move_set(position: &Position) -> BTreeSet<String> {
        let coordinates = generate_normal_legal_moves(position)
            .into_iter()
            .map(|candidate| candidate.to_coordinate())
            .collect::<Vec<_>>();
        let unique = coordinates.iter().cloned().collect::<BTreeSet<_>>();
        assert_eq!(
            coordinates.len(),
            unique.len(),
            "normal legal filtering must not emit duplicate coordinates"
        );
        unique
    }

    fn promotion_move_set(position: &Position) -> BTreeSet<String> {
        generate_normal_legal_moves(position)
            .into_iter()
            .filter(|candidate| candidate.promotion().is_some())
            .map(|candidate| candidate.to_coordinate())
            .collect()
    }

    fn expected(coordinates: &[&str]) -> BTreeSet<String> {
        coordinates
            .iter()
            .map(|coordinate| (*coordinate).to_string())
            .collect()
    }

    #[test]
    fn startpos_normal_legal_moves_are_exactly_twenty() {
        assert_eq!(
            legal_move_set(&Position::startpos()),
            expected(&[
                "a2a3", "a2a4", "b1a3", "b1c3", "b2b3", "b2b4", "c2c3", "c2c4", "d2d3", "d2d4",
                "e2e3", "e2e4", "f2f3", "f2f4", "g1f3", "g1h3", "g2g3", "g2g4", "h2h3", "h2h4",
            ])
        );
    }

    #[test]
    fn pinned_piece_can_only_move_along_the_pin_line_for_both_colors() {
        let white = position("4r1k1/8/8/8/8/8/4R3/4K3 w - - 0 1");
        let black = position("4k3/4r3/8/8/8/8/8/4R1K1 b - - 0 1");

        assert_eq!(
            legal_move_set(&white),
            expected(&[
                "e1d1", "e1d2", "e1f1", "e1f2", "e2e3", "e2e4", "e2e5", "e2e6", "e2e7", "e2e8",
            ])
        );
        assert_eq!(
            legal_move_set(&black),
            expected(&[
                "e8d7", "e8d8", "e8f7", "e8f8", "e7e6", "e7e5", "e7e4", "e7e3", "e7e2", "e7e1",
            ])
        );
    }

    #[test]
    fn single_check_allows_only_capture_block_or_king_escape_for_both_colors() {
        let white = position("4r1k1/8/8/8/8/8/3N4/4K3 w - - 0 1");
        let black = position("4k3/3n4/8/8/8/8/8/4R1K1 b - - 0 1");

        assert_eq!(
            legal_move_set(&white),
            expected(&["e1d1", "e1f1", "e1f2", "d2e4"])
        );
        assert_eq!(
            legal_move_set(&black),
            expected(&["e8d8", "e8f8", "e8f7", "d7e5"])
        );
    }

    #[test]
    fn double_check_allows_only_king_moves_for_both_colors() {
        let white = position("4r1k1/8/8/8/7b/8/8/N3K3 w - - 0 1");
        let black = position("n3k3/8/8/7B/8/8/8/4R1K1 b - - 0 1");

        assert_eq!(legal_move_set(&white), expected(&["e1d1", "e1d2", "e1f1"]));
        assert_eq!(legal_move_set(&black), expected(&["e8d7", "e8d8", "e8f8"]));
    }

    #[test]
    fn king_cannot_capture_defended_piece_and_filtering_does_not_mutate_position() {
        let position = position("8/8/7b/4k3/8/4r3/4K3/8 w - - 0 1");
        let original = position.to_fen();

        assert_eq!(
            legal_move_set(&position),
            expected(&["e2d1", "e2d2", "e2f1", "e2f2"])
        );
        assert_eq!(position.to_fen(), original);
    }

    #[test]
    fn normal_legal_filtering_never_emits_opposing_king_capture() {
        let position = position("4k3/8/8/8/8/8/4R3/6K1 w - - 0 1");

        assert_eq!(
            legal_move_set(&position),
            expected(&[
                "g1f1", "g1f2", "g1g2", "g1h1", "g1h2", "e2e1", "e2e3", "e2e4", "e2e5", "e2e6",
                "e2e7", "e2d2", "e2c2", "e2b2", "e2a2", "e2f2", "e2g2", "e2h2",
            ])
        );
    }

    #[test]
    fn normal_legal_filtering_preserves_all_promotion_candidates() {
        let white = position("k2r1r2/4P3/8/8/8/8/8/4K3 w - - 0 1");
        let black = position("4k3/8/8/8/8/8/4p3/K2R1R2 b - - 0 1");

        assert_eq!(
            promotion_move_set(&white),
            expected(&[
                "e7e8q", "e7e8r", "e7e8b", "e7e8n", "e7d8q", "e7d8r", "e7d8b", "e7d8n", "e7f8q",
                "e7f8r", "e7f8b", "e7f8n",
            ])
        );
        assert_eq!(
            promotion_move_set(&black),
            expected(&[
                "e2e1q", "e2e1r", "e2e1b", "e2e1n", "e2d1q", "e2d1r", "e2d1b", "e2d1n", "e2f1q",
                "e2f1r", "e2f1b", "e2f1n",
            ])
        );
    }

    #[test]
    fn normal_legal_filtering_handles_en_passant_discovered_check() {
        let legal = position("8/8/8/K2pP3/8/8/8/4k3 w - d6 0 1");
        let pinned = position("8/8/8/K2pP2r/8/8/8/4k3 w - d6 0 1");
        let black_legal = position("8/8/8/8/kpP5/8/8/4K3 b - c3 0 1");
        let black_pinned = position("8/8/8/8/kpP4R/8/8/4K3 b - c3 0 1");

        assert!(legal_move_set(&legal).contains("e5d6"));
        assert!(!legal_move_set(&pinned).contains("e5d6"));
        assert!(legal_move_set(&black_legal).contains("b4c3"));
        assert!(!legal_move_set(&black_pinned).contains("b4c3"));
    }
}

#[cfg(test)]
mod terminal_status_tests {
    use super::*;
    use std::collections::BTreeSet;

    fn position(fen: &str) -> Position {
        Position::from_fen(fen).expect("test FEN must parse")
    }

    fn square(algebraic: &str) -> Square {
        Square::from_algebraic(algebraic).expect("test square must parse")
    }

    fn legal_move_set(position: &Position) -> BTreeSet<String> {
        let coordinates = generate_legal_moves(position)
            .into_iter()
            .map(|candidate| candidate.to_coordinate())
            .collect::<Vec<_>>();
        let unique = coordinates.iter().cloned().collect::<BTreeSet<_>>();
        assert_eq!(
            coordinates.len(),
            unique.len(),
            "complete legal helper must not emit duplicate coordinates"
        );
        unique
    }

    fn expected(coordinates: &[&str]) -> BTreeSet<String> {
        coordinates
            .iter()
            .map(|coordinate| (*coordinate).to_string())
            .collect()
    }

    #[test]
    fn complete_legal_helper_combines_normal_and_castling_moves() {
        let position = position("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
        let moves = legal_move_set(&position);

        assert!(moves.contains("a1a8"));
        assert!(moves.contains("e1g1"));
        assert!(moves.contains("e1c1"));
    }

    #[test]
    fn terminal_status_detects_checkmate_and_stalemate_without_mutation() {
        let checkmate = position("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1");
        let stalemate = position("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1");
        let checkmate_fen = checkmate.to_fen();
        let stalemate_fen = stalemate.to_fen();

        assert!(is_in_check(&checkmate, Color::Black));
        assert_eq!(terminal_status(&checkmate), BoardStatus::Checkmate);
        assert_eq!(legal_move_set(&checkmate), expected(&[]));
        assert_eq!(checkmate.to_fen(), checkmate_fen);

        assert!(!is_in_check(&stalemate, Color::Black));
        assert_eq!(terminal_status(&stalemate), BoardStatus::Stalemate);
        assert_eq!(legal_move_set(&stalemate), expected(&[]));
        assert_eq!(stalemate.to_fen(), stalemate_fen);
    }

    #[test]
    fn terminal_status_detects_double_check_mate() {
        let position = position("7k/6Q1/5K2/8/8/8/8/7R b - - 0 1");
        let mut without_queen = position.clone();
        let mut without_rook = position.clone();
        without_queen.set_piece(square("g7"), None);
        without_rook.set_piece(square("h1"), None);

        assert!(is_in_check(&position, Color::Black));
        assert!(is_in_check(&without_queen, Color::Black));
        assert!(is_in_check(&without_rook, Color::Black));
        assert_eq!(terminal_status(&position), BoardStatus::Checkmate);
        assert_eq!(legal_move_set(&position), expected(&[]));
    }

    #[test]
    fn terminal_status_stays_ongoing_when_one_escape_exists() {
        let position = position("7k/6Q1/4K3/8/8/8/8/8 b - - 0 1");

        assert!(is_in_check(&position, Color::Black));
        assert_eq!(terminal_status(&position), BoardStatus::Ongoing);
        assert_eq!(legal_move_set(&position), expected(&["h8g7"]));
    }
}

#[cfg(test)]
mod position_classification_tests {
    use super::*;

    fn position(fen: &str) -> Position {
        Position::from_fen(fen).expect("test FEN must parse")
    }

    #[test]
    fn syntactic_fen_parser_preserves_semantic_classification_issues() {
        let fen = "4k3/8/8/8/8/8/4r3/4K3 b - - 0 1";
        let classified = position(fen);
        let side_to_move_in_check = position("4k3/8/8/8/8/8/4r3/4K3 w - - 0 1");

        assert_eq!(classified.to_fen(), fen);
        assert_eq!(
            classify_position(&classified),
            vec![PositionIssue::SideNotToMoveInCheck(Color::White)]
        );
        assert_eq!(classify_position(&side_to_move_in_check), Vec::new());
    }

    #[test]
    fn position_classification_reports_stale_castling_metadata() {
        let missing = position("4k3/8/8/8/8/8/8/4K3 w Kq - 0 1");
        let wrong_kind = position("4k3/8/8/8/8/8/8/4K2B w K - 0 1");
        let wrong_color = position("4k3/8/8/8/8/8/8/4K2r w K - 0 1");
        let present = position("4k3/8/8/8/8/8/8/4K2R w K - 0 1");

        assert_eq!(
            classify_position(&missing),
            vec![PositionIssue::CastlingRightsWithoutOriginalPieces]
        );
        assert_eq!(
            classify_position(&wrong_kind),
            vec![PositionIssue::CastlingRightsWithoutOriginalPieces]
        );
        assert_eq!(
            classify_position(&wrong_color),
            vec![PositionIssue::CastlingRightsWithoutOriginalPieces]
        );
        assert_eq!(classify_position(&present), Vec::new());
    }

    #[test]
    fn position_classification_reports_uncapturable_en_passant_target() {
        let stale = position("4k3/8/8/8/8/8/8/4K3 w - d6 0 1");
        let capturable = position("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1");
        let pinned_white = position("8/8/8/K2pP2r/8/8/8/4k3 w - d6 0 1");
        let pinned_black = position("8/8/8/8/kpP4R/8/8/4K3 b - c3 0 1");

        assert_eq!(
            classify_position(&stale),
            vec![PositionIssue::EnPassantTargetHasNoLegalCapture]
        );
        assert_eq!(classify_position(&capturable), Vec::new());
        assert_eq!(
            classify_position(&pinned_white),
            vec![PositionIssue::EnPassantTargetHasNoLegalCapture]
        );
        assert_eq!(
            classify_position(&pinned_black),
            vec![PositionIssue::EnPassantTargetHasNoLegalCapture]
        );
    }

    #[test]
    fn position_classification_reports_impossible_material_counts() {
        let too_many_pawns = position("k7/8/8/8/8/P7/PPPPPPPP/7K w - - 0 1");
        let promoted_material = position("k7/8/8/8/8/1QQ5/PPPPPPPP/7K w - - 0 1");
        let plausible_promotion = position("k7/8/8/8/8/1QQ5/1PPPPPPP/7K w - - 0 1");
        let black_too_many_pawns = position("7k/pppppppp/p7/8/8/8/8/K7 b - - 0 1");

        assert_eq!(
            classify_position(&too_many_pawns),
            vec![PositionIssue::ImpossibleMaterialCount(Color::White)]
        );
        assert_eq!(
            classify_position(&promoted_material),
            vec![PositionIssue::ImpossibleMaterialCount(Color::White)]
        );
        assert_eq!(
            classify_position(&black_too_many_pawns),
            vec![PositionIssue::ImpossibleMaterialCount(Color::Black)]
        );
        assert_eq!(classify_position(&plausible_promotion), Vec::new());
    }

    #[test]
    fn position_classification_accepts_startpos() {
        assert_eq!(classify_position(&Position::startpos()), Vec::new());
    }

    #[test]
    fn position_classification_reports_multiple_issues_in_stable_order() {
        let position = position("4k3/8/8/8/8/PPP5/PPP1rPPP/4K3 b K - 0 1");

        assert_eq!(
            classify_position(&position),
            vec![
                PositionIssue::SideNotToMoveInCheck(Color::White),
                PositionIssue::CastlingRightsWithoutOriginalPieces,
                PositionIssue::ImpossibleMaterialCount(Color::White),
            ]
        );
    }
}

#[cfg(test)]
mod castling_generation_tests {
    use super::*;
    use std::collections::BTreeSet;

    fn position(fen: &str) -> Position {
        Position::from_fen(fen).expect("test FEN must parse")
    }

    fn square(coordinate: &str) -> Square {
        Square::from_algebraic(coordinate).expect("test square must parse")
    }

    fn castle_move_set(position: &Position) -> BTreeSet<String> {
        let coordinates = generate_castling_moves(position)
            .into_iter()
            .map(|candidate| candidate.to_coordinate())
            .collect::<Vec<_>>();
        let unique = coordinates.iter().cloned().collect::<BTreeSet<_>>();
        assert_eq!(
            coordinates.len(),
            unique.len(),
            "castling generation must not emit duplicate coordinates"
        );
        unique
    }

    fn expected(coordinates: &[&str]) -> BTreeSet<String> {
        coordinates
            .iter()
            .map(|coordinate| (*coordinate).to_string())
            .collect()
    }

    #[test]
    fn castling_generation_is_side_to_move_and_rights_explicit() {
        let white = position("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
        let black = position("r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1");
        let white_kingside = position("4k3/8/8/8/8/8/8/R3K2R w K - 0 1");
        let white_queenside = position("4k3/8/8/8/8/8/8/R3K2R w Q - 0 1");
        let wrong_color_rights = position("4k3/8/8/8/8/8/8/R3K2R w kq - 0 1");
        let no_rights = position("4k3/8/8/8/8/8/8/R3K2R w - - 0 1");

        assert_eq!(castle_move_set(&white), expected(&["e1c1", "e1g1"]));
        assert_eq!(castle_move_set(&black), expected(&["e8c8", "e8g8"]));
        assert_eq!(castle_move_set(&white_kingside), expected(&["e1g1"]));
        assert_eq!(castle_move_set(&white_queenside), expected(&["e1c1"]));
        assert_eq!(castle_move_set(&wrong_color_rights), expected(&[]));
        assert_eq!(castle_move_set(&no_rights), expected(&[]));
    }

    #[test]
    fn castling_requires_clear_path_and_original_king_and_rook_geometry() {
        let kingside_blocked = position("4k3/8/8/8/8/8/8/R3KB1R w KQ - 0 1");
        let queenside_blocked = position("4k3/8/8/8/8/8/8/R2nK2R w KQ - 0 1");
        let missing_rook = position("4k3/8/8/8/8/8/8/R3K3 w KQ - 0 1");
        let wrong_rook_piece = position("4k3/8/8/8/8/8/8/B3K2R w Q - 0 1");
        let misplaced_king = position("4k3/8/8/8/8/8/8/R2K3R w KQ - 0 1");
        let mut missing_king = position("4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1");
        missing_king.set_piece(Square::new(File::E, Rank::First), None);

        assert_eq!(castle_move_set(&kingside_blocked), expected(&["e1c1"]));
        assert_eq!(castle_move_set(&queenside_blocked), expected(&["e1g1"]));
        assert_eq!(castle_move_set(&missing_rook), expected(&["e1c1"]));
        assert_eq!(castle_move_set(&wrong_rook_piece), expected(&[]));
        assert_eq!(castle_move_set(&misplaced_king), expected(&[]));
        assert_eq!(castle_move_set(&missing_king), expected(&[]));
    }

    #[test]
    fn castling_rejects_current_transit_destination_and_stale_blocker_attacks() {
        let current_check = position("4r1k1/8/8/8/8/8/8/R3K2R w KQ - 0 1");
        let transit_attacked = position("6k1/8/b7/8/8/8/8/R3K2R w KQ - 0 1");
        let destination_attacked = position("6rk/8/8/8/8/8/8/R3K2R w KQ - 0 1");
        let stale_origin_blocker = position("7k/8/8/8/8/8/8/r3K2R w K - 0 1");
        let black_current_check = position("r3k2r/8/8/8/8/8/8/4R1K1 b kq - 0 1");
        let black_transit_attacked = position("r3k2r/8/8/8/8/B7/8/6K1 b kq - 0 1");
        let black_destination_attacked = position("r3k2r/8/8/8/8/1B6/8/6K1 b kq - 0 1");

        assert_eq!(castle_move_set(&current_check), expected(&[]));
        assert_eq!(castle_move_set(&transit_attacked), expected(&["e1c1"]));
        assert_eq!(castle_move_set(&destination_attacked), expected(&["e1c1"]));
        assert_eq!(castle_move_set(&stale_origin_blocker), expected(&[]));
        assert_eq!(castle_move_set(&black_current_check), expected(&[]));
        assert_eq!(
            castle_move_set(&black_transit_attacked),
            expected(&["e8c8"])
        );
        assert_eq!(
            castle_move_set(&black_destination_attacked),
            expected(&["e8c8"])
        );
    }

    #[test]
    fn castling_does_not_reject_attacked_rook_or_non_king_path_squares() {
        let attacked_queenside_b1 = position("4k3/8/8/8/8/8/b7/R3K2R w Q - 0 1");
        let attacked_kingside_rook = position("4k3/8/8/8/8/8/5n2/R3K2R w K - 0 1");
        let original = attacked_queenside_b1.to_fen();

        assert_eq!(castle_move_set(&attacked_queenside_b1), expected(&["e1c1"]));
        assert_eq!(attacked_queenside_b1.to_fen(), original);
        assert_eq!(
            castle_move_set(&attacked_kingside_rook),
            expected(&["e1g1"])
        );
    }

    #[test]
    fn castling_attack_probe_snapshots_are_explicit() {
        let transit = position("7k/8/8/8/8/8/8/r3K2R w K - 0 1");
        let destination = position("4k3/8/8/8/8/8/8/R3K2r w Q - 0 1");

        assert!(!is_castle_king_square_safe(
            &transit,
            Color::White,
            square("e1"),
            square("f1"),
            None,
        ));
        assert!(!is_castle_king_square_safe(
            &destination,
            Color::White,
            square("e1"),
            square("c1"),
            None,
        ));
        assert!(is_castle_king_square_safe(
            &destination,
            Color::White,
            square("e1"),
            square("c1"),
            Some((square("a1"), square("d1"))),
        ));
    }
}

#[cfg(test)]
mod reversible_application_tests {
    use super::*;

    fn position(fen: &str) -> Position {
        Position::from_fen(fen).expect("test FEN must parse")
    }

    fn candidate(coordinate: &str) -> Move {
        Move::from_coordinate(coordinate).expect("test move must parse")
    }

    fn assert_make_unmake(start: &str, coordinate: &str, after: &str) {
        let mut position = position(start);
        let undo = make_reversible_move(&mut position, candidate(coordinate))
            .expect("test move must apply");

        assert_eq!(position.to_fen(), after, "post-make FEN mismatch");

        unmake_reversible_move(&mut position, undo);
        assert_eq!(position.to_fen(), start, "restored FEN mismatch");
    }

    fn assert_rejected_without_mutation(start: &str, coordinate: &str) {
        let mut position = position(start);
        let original = position.to_fen();

        assert_eq!(
            make_reversible_move(&mut position, candidate(coordinate)),
            None
        );
        assert_eq!(position.to_fen(), original);
    }

    #[test]
    fn king_moves_clear_both_own_castling_rights_and_unmake_restores_fen() {
        assert_make_unmake(
            "r3k2r/8/8/8/8/8/4K3/R6R w KQkq - 5 17",
            "e2e3",
            "r3k2r/8/8/8/8/4K3/8/R6R b kq - 6 17",
        );
        assert_make_unmake(
            "r6r/8/4k3/8/8/8/4K3/R6R b KQkq - 5 17",
            "e6e5",
            "r6r/8/8/4k3/8/8/4K3/R6R w KQ - 6 18",
        );
    }

    #[test]
    fn original_rook_moves_clear_only_matching_side_right_and_unmake_restores_fen() {
        assert_make_unmake(
            "4k3/8/8/8/8/8/8/R3K2R w KQ - 3 9",
            "h1h2",
            "4k3/8/8/8/8/8/7R/R3K3 b Q - 4 9",
        );
        assert_make_unmake(
            "4k3/8/8/8/8/8/8/R3K2R w KQ - 3 9",
            "a1a2",
            "4k3/8/8/8/8/8/R7/4K2R b K - 4 9",
        );
        assert_make_unmake(
            "r3k2r/8/8/8/8/8/8/4K3 b kq - 3 9",
            "h8h7",
            "r3k3/7r/8/8/8/8/8/4K3 w q - 4 10",
        );
        assert_make_unmake(
            "r3k2r/8/8/8/8/8/8/4K3 b kq - 3 9",
            "a8a7",
            "4k2r/r7/8/8/8/8/8/4K3 w k - 4 10",
        );
    }

    #[test]
    fn non_original_rook_move_does_not_clear_castling_rights() {
        assert_make_unmake(
            "4k3/8/8/8/8/8/3R4/4K3 w KQ - 0 1",
            "d2d3",
            "4k3/8/8/8/8/3R4/8/4K3 b KQ - 1 1",
        );
    }

    #[test]
    fn capturing_original_rook_clears_only_captured_side_right() {
        assert_make_unmake(
            "r3k2r/6B1/8/8/8/8/8/R3K2R w KQkq - 7 12",
            "g7h8",
            "r3k2B/8/8/8/8/8/8/R3K2R b KQq - 0 12",
        );
        assert_make_unmake(
            "r3k2r/1B6/8/8/8/8/8/R3K2R w KQkq - 7 12",
            "b7a8",
            "B3k2r/8/8/8/8/8/8/R3K2R b KQk - 0 12",
        );
        assert_make_unmake(
            "r3k2r/8/8/8/8/8/1b6/R3K2R b KQkq - 7 12",
            "b2a1",
            "r3k2r/8/8/8/8/8/8/b3K2R w Kkq - 0 13",
        );
        assert_make_unmake(
            "r3k2r/8/8/8/8/8/6b1/R3K2R b KQkq - 7 12",
            "g2h1",
            "r3k2r/8/8/8/8/8/8/R3K2b w Qkq - 0 13",
        );
    }

    #[test]
    fn capturing_non_original_rook_does_not_clear_castling_rights() {
        assert_make_unmake(
            "r3k2r/8/8/3r4/8/8/6B1/R3K2R w KQkq - 9 20",
            "g2d5",
            "r3k2r/8/8/3B4/8/8/8/R3K2R b KQkq - 0 20",
        );
    }

    #[test]
    fn castling_moves_king_and_rook_clear_own_rights_and_unmake_restores_fen() {
        assert_make_unmake(
            "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 4 11",
            "e1g1",
            "r3k2r/8/8/8/8/8/8/R4RK1 b kq - 5 11",
        );
        assert_make_unmake(
            "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 4 11",
            "e1c1",
            "r3k2r/8/8/8/8/8/8/2KR3R b kq - 5 11",
        );
        assert_make_unmake(
            "r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 4 11",
            "e8g8",
            "r4rk1/8/8/8/8/8/8/R3K2R w KQ - 5 12",
        );
        assert_make_unmake(
            "r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 4 11",
            "e8c8",
            "2kr3r/8/8/8/8/8/8/R3K2R w KQ - 5 12",
        );
    }

    #[test]
    fn non_king_moves_on_castling_coordinates_apply_as_normal_moves() {
        assert_make_unmake(
            "4k3/8/8/8/8/8/8/4R1K1 w - - 0 1",
            "e1c1",
            "4k3/8/8/8/8/8/8/2R3K1 b - - 1 1",
        );
        assert_make_unmake(
            "4r1k1/8/8/8/8/8/8/4K3 b - - 0 1",
            "e8c8",
            "2r3k1/8/8/8/8/8/8/4K3 w - - 1 2",
        );
    }

    #[test]
    fn m6b_state_policy_updates_side_clocks_and_capturable_en_passant_target() {
        assert_make_unmake(
            "4k3/8/8/3pP3/8/8/4K3/7R w K d6 7 3",
            "h1h2",
            "4k3/8/8/3pP3/8/8/4K2R/8 b - - 8 3",
        );
        assert_make_unmake(
            "4k3/8/8/8/8/8/4P3/4K3 w - - 9 1",
            "e2e4",
            "4k3/8/8/8/4P3/8/8/4K3 b - - 0 1",
        );
        assert_make_unmake(
            "4k3/4p3/8/8/8/8/8/4K3 b - - 6 4",
            "e7e5",
            "4k3/8/8/4p3/8/8/8/4K3 w - - 0 5",
        );
        assert_make_unmake(
            "4k3/8/8/8/3p4/8/4P3/4K3 w - - 9 1",
            "e2e4",
            "4k3/8/8/8/3pP3/8/8/4K3 b - e3 0 1",
        );
        assert_make_unmake(
            "4k3/4p3/8/3P4/8/8/8/4K3 b - - 6 4",
            "e7e5",
            "4k3/8/8/3Pp3/8/8/8/4K3 w - e6 0 5",
        );
    }

    #[test]
    fn en_passant_application_removes_captured_pawn_and_unmake_restores_fen() {
        assert_make_unmake(
            "4k3/8/8/3pP3/8/8/8/4K3 w - d6 9 2",
            "e5d6",
            "4k3/8/3P4/8/8/8/8/4K3 b - - 0 2",
        );
        assert_make_unmake(
            "4k3/8/8/8/3pP3/8/8/4K3 b - e3 9 2",
            "d4e3",
            "4k3/8/8/8/8/4p3/8/4K3 w - - 0 3",
        );
    }

    #[test]
    fn invalid_en_passant_applications_reject_without_mutation() {
        assert_rejected_without_mutation("4k3/8/8/4P3/8/8/8/4K3 w - d6 0 1", "e5d6");
        assert_rejected_without_mutation("4k3/8/3N4/3pP3/8/8/8/4K3 w - d6 0 1", "e5d6");
        assert_rejected_without_mutation("4k3/8/8/3PP3/8/8/8/4K3 w - d6 0 1", "e5d6");
        assert_rejected_without_mutation("4k3/8/8/3pP3/8/8/8/4K3 w - - 0 1", "e5d6");
        assert_rejected_without_mutation("4k3/8/8/8/3p4/8/8/4K3 b - e3 0 1", "d4e3");
        assert_rejected_without_mutation("4k3/8/8/8/3pp3/8/8/4K3 b - e3 0 1", "d4e3");
        assert_rejected_without_mutation("4k3/8/8/8/3pP3/8/8/4K3 b - - 0 1", "d4e3");
    }

    #[test]
    fn invalid_or_out_of_scope_moves_are_rejected_without_mutation() {
        assert_rejected_without_mutation("4k3/8/8/8/8/8/8/4K3 w - - 0 1", "a1a2");
        assert_rejected_without_mutation("r3k3/8/8/8/8/8/8/4K3 w q - 0 1", "a8a7");
        assert_rejected_without_mutation("4k3/8/8/8/8/8/8/R3K3 w Q - 0 1", "e1a1");
        assert_rejected_without_mutation("4k3/8/8/8/8/8/4R3/4K3 w - - 0 1", "e2e8");
        assert_rejected_without_mutation("r3k2r/8/8/8/8/8/8/R3K2R w Qkq - 0 1", "e1g1");
        assert_rejected_without_mutation("r3k2r/8/8/8/8/8/8/R3KB1R w KQkq - 0 1", "e1g1");
        assert_rejected_without_mutation("r3k2r/8/8/8/8/8/8/R3K3 w KQkq - 0 1", "e1g1");
        assert_rejected_without_mutation("4r1k1/8/8/8/8/8/8/R3K2R w KQ - 0 1", "e1g1");
        assert_rejected_without_mutation("6k1/8/b7/8/8/8/8/R3K2R w KQ - 0 1", "e1g1");
        assert_rejected_without_mutation("6rk/8/8/8/8/8/8/R3K2R w KQ - 0 1", "e1g1");
    }

    #[test]
    fn quiet_promotions_apply_each_piece_and_unmake_restores_fen() {
        for (coordinate, after) in [
            ("e7e8q", "k3Q3/8/8/8/8/8/8/4K3 b - - 0 1"),
            ("e7e8r", "k3R3/8/8/8/8/8/8/4K3 b - - 0 1"),
            ("e7e8b", "k3B3/8/8/8/8/8/8/4K3 b - - 0 1"),
            ("e7e8n", "k3N3/8/8/8/8/8/8/4K3 b - - 0 1"),
        ] {
            assert_make_unmake("k7/4P3/8/8/8/8/8/4K3 w - - 5 1", coordinate, after);
        }

        for (coordinate, after) in [
            ("e2e1q", "4k3/8/8/8/8/8/8/K3q3 w - - 0 10"),
            ("e2e1r", "4k3/8/8/8/8/8/8/K3r3 w - - 0 10"),
            ("e2e1b", "4k3/8/8/8/8/8/8/K3b3 w - - 0 10"),
            ("e2e1n", "4k3/8/8/8/8/8/8/K3n3 w - - 0 10"),
        ] {
            assert_make_unmake("4k3/8/8/8/8/8/4p3/K7 b - - 5 9", coordinate, after);
        }
    }

    #[test]
    fn capture_promotions_apply_each_piece_and_restore_captures() {
        for (coordinate, after) in [
            ("e7d8q", "k2Q4/8/8/8/8/8/8/4K3 b - - 0 2"),
            ("e7d8r", "k2R4/8/8/8/8/8/8/4K3 b - - 0 2"),
            ("e7d8b", "k2B4/8/8/8/8/8/8/4K3 b - - 0 2"),
            ("e7d8n", "k2N4/8/8/8/8/8/8/4K3 b - - 0 2"),
        ] {
            assert_make_unmake("k2r4/4P3/8/8/8/8/8/4K3 w - - 8 2", coordinate, after);
        }

        for (coordinate, after) in [
            ("e2d1q", "4k3/8/8/8/8/8/8/K2q4 w - - 0 3"),
            ("e2d1r", "4k3/8/8/8/8/8/8/K2r4 w - - 0 3"),
            ("e2d1b", "4k3/8/8/8/8/8/8/K2b4 w - - 0 3"),
            ("e2d1n", "4k3/8/8/8/8/8/8/K2n4 w - - 0 3"),
        ] {
            assert_make_unmake("4k3/8/8/8/8/8/4p3/K2R4 b - - 8 2", coordinate, after);
        }
    }

    #[test]
    fn promotion_captures_original_rooks_update_castling_rights_and_restore_fen() {
        assert_make_unmake(
            "r3k2r/6P1/8/8/8/8/8/4K3 w kq - 9 12",
            "g7h8q",
            "r3k2Q/8/8/8/8/8/8/4K3 b q - 0 12",
        );
        assert_make_unmake(
            "r3k2r/1P6/8/8/8/8/8/4K3 w kq - 9 12",
            "b7a8q",
            "Q3k2r/8/8/8/8/8/8/4K3 b k - 0 12",
        );
        assert_make_unmake(
            "4k3/8/8/8/8/8/6p1/R3K2R b KQ - 9 12",
            "g2h1q",
            "4k3/8/8/8/8/8/8/R3K2q w Q - 0 13",
        );
        assert_make_unmake(
            "4k3/8/8/8/8/8/1p6/R3K2R b KQ - 9 12",
            "b2a1q",
            "4k3/8/8/8/8/8/8/q3K2R w K - 0 13",
        );
    }

    #[test]
    fn invalid_promotion_applications_reject_without_mutation() {
        assert_rejected_without_mutation("k7/4R3/8/8/8/8/8/4K3 w - - 0 1", "e7e8q");
        assert_rejected_without_mutation("4k3/8/8/8/8/8/4r3/K7 b - - 0 1", "e2e1q");
        assert_rejected_without_mutation("k7/4P3/8/8/8/8/8/4K3 w - - 0 1", "e7e8");
        assert_rejected_without_mutation("4k3/8/8/8/8/8/4p3/K7 b - - 0 1", "e2e1");
        assert_rejected_without_mutation("k7/4P3/8/8/8/8/8/4K3 w - - 0 1", "e7a8q");
        assert_rejected_without_mutation("k7/4P3/8/8/8/8/8/4K3 w - - 0 1", "e7f8q");
        assert_rejected_without_mutation("k3r3/4P3/8/8/8/8/8/4K3 w - - 0 1", "e7e8q");
        assert_rejected_without_mutation("4k3/8/8/8/8/8/4P3/K7 w - - 0 1", "e2e1q");
        assert_rejected_without_mutation("k7/4p3/8/8/8/8/8/4K3 b - - 0 1", "e7e8q");
    }
}

#[cfg(test)]
mod bitboard_equivalence_tests {
    //! The mailbox move generator and attack detector the bitboards replaced, kept only as the
    //! reference the bitboard path must match on every walked position.
    use super::*;

    const BISHOP_DIRECTIONS: [(i8, i8); 4] = [(-1, -1), (-1, 1), (1, -1), (1, 1)];
    const ROOK_DIRECTIONS: [(i8, i8); 4] = [(-1, 0), (0, -1), (0, 1), (1, 0)];

    fn step(square: Square, (file_delta, rank_delta): (i8, i8)) -> Option<Square> {
        square.offset(file_delta, rank_delta)
    }

    fn reference_pseudo_moves(position: &Position, color: Color) -> Vec<Move> {
        let mut moves = Vec::new();
        for from in all_squares() {
            let Some(piece) = position
                .piece_at(from)
                .filter(|piece| piece.color() == color)
            else {
                continue;
            };
            let target_ok = |to: Square| position.piece_at(to).is_none_or(|p| p.color() != color);
            match piece.kind() {
                PieceKind::Pawn => {
                    add_pawn_quiet_moves(position, color, from, &mut moves);
                    let forward = if color == Color::White { 1 } else { -1 };
                    for file_delta in [-1, 1] {
                        if let Some(to) = step(from, (file_delta, forward)) {
                            if position.piece_at(to).is_some_and(|p| p.color() != color) {
                                add_pawn_candidate(from, to, &mut moves);
                            }
                        }
                    }
                    add_pawn_en_passant(position, color, from, &mut moves);
                }
                PieceKind::Knight | PieceKind::King => {
                    let offsets = if piece.kind() == PieceKind::Knight {
                        KNIGHT_OFFSETS
                    } else {
                        KING_OFFSETS
                    };
                    for offset in offsets {
                        if let Some(to) = step(from, offset).filter(|to| target_ok(*to)) {
                            moves.push(Move::new(from, to, None).expect("leaper move"));
                        }
                    }
                }
                PieceKind::Bishop | PieceKind::Rook | PieceKind::Queen => {
                    let directions: Vec<(i8, i8)> = match piece.kind() {
                        PieceKind::Bishop => BISHOP_DIRECTIONS.to_vec(),
                        PieceKind::Rook => ROOK_DIRECTIONS.to_vec(),
                        _ => [BISHOP_DIRECTIONS, ROOK_DIRECTIONS].concat(),
                    };
                    for direction in directions {
                        let mut current = from;
                        while let Some(to) = step(current, direction) {
                            if target_ok(to) {
                                moves.push(Move::new(from, to, None).expect("slider move"));
                            }
                            if position.piece_at(to).is_some() {
                                break;
                            }
                            current = to;
                        }
                    }
                }
            }
        }
        moves
    }

    fn reference_is_square_attacked(position: &Position, square: Square, by: Color) -> bool {
        let holds = |origin: Option<Square>, kinds: &[PieceKind]| {
            origin
                .and_then(|origin| position.piece_at(origin))
                .is_some_and(|piece| piece.color() == by && kinds.contains(&piece.kind()))
        };
        let backward = if by == Color::White { -1 } else { 1 };
        let pawn = [-1, 1]
            .into_iter()
            .any(|file_delta| holds(step(square, (file_delta, backward)), &[PieceKind::Pawn]));
        let knight = KNIGHT_OFFSETS
            .into_iter()
            .any(|offset| holds(step(square, offset), &[PieceKind::Knight]));
        let king = KING_OFFSETS
            .into_iter()
            .any(|offset| holds(step(square, offset), &[PieceKind::King]));
        let slider = |directions: [(i8, i8); 4], kinds: &[PieceKind]| {
            directions.into_iter().any(|direction| {
                let mut current = square;
                while let Some(next) = step(current, direction) {
                    if position.piece_at(next).is_some() {
                        return holds(Some(next), kinds);
                    }
                    current = next;
                }
                false
            })
        };
        pawn || knight
            || king
            || slider(BISHOP_DIRECTIONS, &[PieceKind::Bishop, PieceKind::Queen])
            || slider(ROOK_DIRECTIONS, &[PieceKind::Rook, PieceKind::Queen])
    }

    fn sorted(mut moves: Vec<Move>) -> Vec<Move> {
        moves.sort_unstable();
        moves
    }

    fn assert_matches_reference(position: &Position) {
        assert_eq!(position.bitboards, Bitboards::scan(&position.board));
        let fen = position.to_fen();
        for color in [Color::White, Color::Black] {
            assert_eq!(
                sorted(generate_normal_pseudo_moves(position, color)),
                sorted(reference_pseudo_moves(position, color)),
                "{fen} {color:?}"
            );
            for square in all_squares() {
                assert_eq!(
                    is_square_attacked(position, square, color),
                    reference_is_square_attacked(position, square, color),
                    "{fen} {color:?} {}",
                    square.to_algebraic()
                );
            }
        }
    }

    fn walk(position: &mut Position, depth: u8) {
        assert_matches_reference(position);
        if depth == 0 {
            return;
        }
        for candidate in generate_legal_moves(position) {
            let undo = make_reversible_move(position, candidate).expect("legal move must apply");
            walk(position, depth - 1);
            unmake_reversible_move(position, undo);
            assert_eq!(position.bitboards, Bitboards::scan(&position.board));
        }
    }

    #[test]
    fn bitboard_movegen_and_attacks_match_the_mailbox_reference_on_walked_positions() {
        // Depths keep the whole walk near 16k positions so a debug build stays around ten seconds.
        for (fen, depth) in [
            (
                "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
                3,
            ),
            (
                "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
                2,
            ),
            ("r3k2r/1P6/8/8/8/8/6p1/R3K2R b KQkq - 0 1", 2),
            ("8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", 3),
            (
                "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
                2,
            ),
            (
                "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8",
                2,
            ),
        ] {
            walk(
                &mut Position::from_fen(fen).expect("test FEN must parse"),
                depth,
            );
        }
    }
}

#[cfg(test)]
mod reversible_traversal_tests {
    use super::*;

    const STARTPOS: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const KIWIPETE: &str = "r3k2r/p1ppqpb1/bn2pnp1/2P5/1p2P3/2N2N2/PP1PBPPP/R2QKB1R w KQkq - 0 1";
    const CASTLING: &str = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 4 11";
    const PROMOTION: &str = "k2r1r2/4P3/8/8/8/8/8/4K3 w - - 8 2";
    const EN_PASSANT: &str = "4k3/8/8/K2pP3/8/8/8/8 w - d6 9 2";
    const IN_CHECK: &str = "4k3/8/8/8/8/8/4r3/4K3 w - - 0 1";
    const CAPTURE: &str = "r3k2r/8/8/3r4/8/8/6B1/R3K2R w KQkq - 9 20";

    fn position(fen: &str) -> Position {
        Position::from_fen(fen).expect("test FEN must parse")
    }

    fn candidate(coordinate: &str) -> Move {
        Move::from_coordinate(coordinate).expect("test move must parse")
    }

    fn legal_moves_for(label: &str, position: &Position) -> Vec<Move> {
        let issues = classify_position(position);
        assert!(
            issues.is_empty(),
            "{label} has classifier issues: {issues:?}"
        );

        generate_legal_moves(position)
    }

    fn traversal_fixtures() -> [(&'static str, &'static str); 7] {
        [
            ("startpos", STARTPOS),
            ("kiwipete", KIWIPETE),
            ("castling", CASTLING),
            ("promotion", PROMOTION),
            ("en_passant", EN_PASSANT),
            ("in_check", IN_CHECK),
            ("capture", CAPTURE),
        ]
    }

    fn assert_post_make(start: &str, coordinate: &str, after: &str) {
        let mut position = position(start);
        let legal_moves = legal_moves_for("post-make fixture", &position);
        let candidate = candidate(coordinate);
        assert!(
            legal_moves.contains(&candidate),
            "{coordinate} must be a legal fixture move"
        );

        let undo = make_reversible_move(&mut position, candidate).expect("legal move must apply");
        assert_eq!(position.to_fen(), after, "{coordinate} post-make FEN");

        unmake_reversible_move(&mut position, undo);
        assert_eq!(position.to_fen(), start, "{coordinate} restored FEN");
    }

    fn assert_state_fields(
        start: &str,
        coordinate: &str,
        after: &str,
        side_to_move: Color,
        en_passant: Option<&str>,
        halfmove_clock: u32,
        fullmove_number: u32,
    ) {
        let mut position = position(start);
        let expected = Position::from_fen(after).expect("expected FEN must parse");
        let undo =
            make_reversible_move(&mut position, candidate(coordinate)).expect("move must apply");

        assert_eq!(position.side_to_move(), side_to_move, "{coordinate} side");
        assert_eq!(
            position
                .en_passant_target()
                .map(|square| square.to_algebraic()),
            en_passant.map(str::to_string),
            "{coordinate} en-passant"
        );
        assert_eq!(
            position.castling_rights(),
            expected.castling_rights(),
            "{coordinate} castling"
        );
        assert_eq!(
            position.halfmove_clock(),
            halfmove_clock,
            "{coordinate} halfmove"
        );
        assert_eq!(
            position.fullmove_number(),
            fullmove_number,
            "{coordinate} fullmove"
        );

        unmake_reversible_move(&mut position, undo);
        assert_eq!(position.to_fen(), start, "{coordinate} restored FEN");
    }

    fn assert_public_and_trusted_moves_match(label: &str, position: &Position) {
        assert_eq!(
            position
                .legal_moves()
                .unwrap_or_else(|_| panic!("{label} public legal moves")),
            position.legal_moves_trusted(),
            "{label} public/trusted legal move parity"
        );
    }

    #[test]
    fn make_unmake_restores_exact_fen_for_every_legal_move_in_selected_fixtures() {
        for (label, fen) in traversal_fixtures() {
            let mut position = position(fen);
            let root = position.to_fen();
            let root_hash = position.zobrist_hash();
            let moves = legal_moves_for(label, &position);
            assert!(!moves.is_empty(), "{label} should have legal moves");

            for candidate in moves {
                let coordinate = candidate.to_coordinate();
                let undo = make_reversible_move(&mut position, candidate)
                    .unwrap_or_else(|| panic!("{label} {coordinate} must apply"));

                unmake_reversible_move(&mut position, undo);
                assert_eq!(position.to_fen(), root, "{label} {coordinate} restored FEN");
                assert_eq!(
                    position.zobrist_hash(),
                    root_hash,
                    "{label} {coordinate} restored hash"
                );
            }
        }
    }

    #[test]
    fn depth_two_make_unmake_restores_child_and_root_fens_after_every_branch() {
        for (label, fen) in traversal_fixtures() {
            let mut position = position(fen);
            let root = position.to_fen();
            let root_hash = position.zobrist_hash();
            let root_moves = legal_moves_for(label, &position);
            assert!(!root_moves.is_empty(), "{label} should have legal moves");

            for root_move in root_moves {
                let root_coordinate = root_move.to_coordinate();
                let root_undo = make_reversible_move(&mut position, root_move)
                    .unwrap_or_else(|| panic!("{label} {root_coordinate} must apply"));
                let child = position.to_fen();
                let child_hash = position.zobrist_hash();
                let child_moves = generate_legal_moves(&position);

                for child_move in child_moves {
                    let child_coordinate = child_move.to_coordinate();
                    let child_undo = make_reversible_move(&mut position, child_move)
                        .unwrap_or_else(|| {
                            panic!("{label} {root_coordinate} {child_coordinate} must apply")
                        });

                    unmake_reversible_move(&mut position, child_undo);
                    assert_eq!(
                        position.to_fen(),
                        child,
                        "{label} {root_coordinate} {child_coordinate} restored child FEN"
                    );
                    assert_eq!(
                        position.zobrist_hash(),
                        child_hash,
                        "{label} {root_coordinate} {child_coordinate} restored child hash"
                    );
                }

                unmake_reversible_move(&mut position, root_undo);
                assert_eq!(
                    position.to_fen(),
                    root,
                    "{label} {root_coordinate} restored root FEN"
                );
                assert_eq!(
                    position.zobrist_hash(),
                    root_hash,
                    "{label} {root_coordinate} restored root hash"
                );
            }
        }
    }

    #[test]
    fn public_and_trusted_legal_moves_match_across_fixture_children() {
        for (label, fen) in traversal_fixtures() {
            let mut position = position(fen);
            assert_public_and_trusted_moves_match(label, &position);

            for candidate in legal_moves_for(label, &position) {
                let coordinate = candidate.to_coordinate();
                let undo = make_reversible_move(&mut position, candidate)
                    .unwrap_or_else(|| panic!("{label} {coordinate} must apply"));
                assert_public_and_trusted_moves_match(
                    &format!("{label} child {coordinate}"),
                    &position,
                );
                unmake_reversible_move(&mut position, undo);
            }
        }
    }

    #[test]
    fn undo_state_restores_complete_private_board_state() {
        for (label, fen) in traversal_fixtures() {
            let mut position = position(fen);
            let root = position.to_fen();
            let root_hash = position.zobrist_hash();
            let root_state = position.board_state();

            for candidate in legal_moves_for(label, &position) {
                let coordinate = candidate.to_coordinate();
                let undo = make_reversible_move(&mut position, candidate)
                    .unwrap_or_else(|| panic!("{label} {coordinate} must apply"));
                assert_ne!(
                    position.board_state(),
                    root_state,
                    "{label} {coordinate} must change board state"
                );

                unmake_reversible_move(&mut position, undo);
                assert_eq!(
                    position.board_state(),
                    root_state,
                    "{label} {coordinate} restored board state"
                );
                assert_eq!(position.to_fen(), root, "{label} {coordinate} restored FEN");
                assert_eq!(
                    position.zobrist_hash(),
                    root_hash,
                    "{label} {coordinate} restored hash"
                );
            }
        }
    }

    #[test]
    fn representative_post_make_fens_are_exact() {
        assert_post_make(
            STARTPOS,
            "e2e4",
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
        );
        assert_post_make(CASTLING, "e1g1", "r3k2r/8/8/8/8/8/8/R4RK1 b kq - 5 11");
        assert_post_make(PROMOTION, "e7d8q", "k2Q1r2/8/8/8/8/8/8/4K3 b - - 0 2");
        assert_post_make(EN_PASSANT, "e5d6", "4k3/8/3P4/K7/8/8/8/8 b - - 0 2");
        assert_post_make(CAPTURE, "g2d5", "r3k2r/8/8/3B4/8/8/8/R3K2R b KQkq - 0 20");
        assert_post_make(IN_CHECK, "e1e2", "4k3/8/8/8/8/8/4K3/8 b - - 0 1");
    }

    #[test]
    fn representative_state_fields_are_explicit_after_make() {
        assert_state_fields(
            STARTPOS,
            "e2e4",
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
            Color::Black,
            None,
            0,
            1,
        );
        assert_state_fields(
            CASTLING,
            "e1g1",
            "r3k2r/8/8/8/8/8/8/R4RK1 b kq - 5 11",
            Color::Black,
            None,
            5,
            11,
        );
        assert_state_fields(
            EN_PASSANT,
            "e5d6",
            "4k3/8/3P4/K7/8/8/8/8 b - - 0 2",
            Color::Black,
            None,
            0,
            2,
        );
        assert_state_fields(
            "4k3/8/8/8/3p4/8/4P3/4K3 w - - 9 1",
            "e2e4",
            "4k3/8/8/8/3pP3/8/8/4K3 b - e3 0 1",
            Color::Black,
            Some("e3"),
            0,
            1,
        );
        assert_state_fields(
            CAPTURE,
            "g2d5",
            "r3k2r/8/8/3B4/8/8/8/R3K2R b KQkq - 0 20",
            Color::Black,
            None,
            0,
            20,
        );
    }

    #[test]
    fn public_legal_moves_accept_generated_double_push_without_capturable_en_passant() {
        let mut position = position(STARTPOS);
        let undo = make_reversible_move(&mut position, candidate("e2e4"))
            .expect("startpos double push must apply");

        assert_eq!(
            position.to_fen(),
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
        );
        assert!(
            position.legal_moves().is_ok(),
            "public legal_moves must accept a generated child position"
        );

        unmake_reversible_move(&mut position, undo);
        assert_eq!(position.to_fen(), STARTPOS);
    }

    #[test]
    fn terminal_positions_traverse_zero_moves_without_mutation() {
        for (label, fen) in [
            ("checkmate", "7k/6Q1/6K1/8/8/8/8/8 b - - 0 1"),
            ("stalemate", "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1"),
        ] {
            let position = position(fen);

            assert!(classify_position(&position).is_empty(), "{label}");
            assert_eq!(generate_legal_moves(&position), [], "{label}");
            assert_eq!(position.to_fen(), fen, "{label} FEN");
        }
    }

    #[test]
    fn zobrist_hash_restores_after_internal_make_unmake() {
        let mut position = position(STARTPOS);
        let original_hash = position.zobrist_hash();
        let original_fen = position.to_fen();

        let undo =
            make_reversible_move(&mut position, candidate("e2e4")).expect("legal move must apply");
        assert_ne!(position.zobrist_hash(), original_hash);

        unmake_reversible_move(&mut position, undo);
        assert_eq!(position.to_fen(), original_fen);
        assert_eq!(position.zobrist_hash(), original_hash);
    }

    #[test]
    fn null_move_updates_incremental_hash_and_expires_en_passant() {
        for fen in [
            STARTPOS,
            "r3k2r/8/8/3pP3/8/8/8/R3K2R w KQkq d6 0 12",
            "r3k2r/8/8/8/3pP3/8/8/R3K2R b KQkq e3 0 12",
            "4k3/8/8/8/8/8/8/4K2R b - - 99 42",
        ] {
            let parent = position(fen);
            let child = parent.after_null_move();
            assert_eq!(child.zobrist_hash(), super::zobrist_hash(&child), "{fen}");
            assert_eq!(
                child.zobrist_hash(),
                position(&child.to_fen()).zobrist_hash()
            );
            assert_eq!(child.board, parent.board);
            assert_eq!(child.bitboards, parent.bitboards);
            assert_eq!(child.castling_rights(), parent.castling_rights());
            assert_eq!(child.side_to_move(), parent.side_to_move().opposite());
            assert_eq!(child.en_passant_target(), None);
            assert_eq!(child.halfmove_clock(), parent.halfmove_clock() + 1);
            assert_eq!(
                child.fullmove_number(),
                parent.fullmove_number() + u32::from(parent.side_to_move() == Color::Black)
            );
            assert_eq!(parent.to_fen(), fen);
        }
    }

    #[test]
    fn incremental_hash_matches_full_hash_through_special_moves_and_undo() {
        for fen in [
            STARTPOS,
            KIWIPETE,
            "r3k2r/1P6/8/8/8/8/6p1/R3K2R b KQkq - 0 1",
            "r3k2r/8/8/3pP3/8/8/8/R3K2R w KQkq d6 0 12",
            "r3k2r/8/8/8/3pP3/8/8/R3K2R b KQkq e3 0 12",
        ] {
            let mut parent = position(fen);
            for mv in parent.legal_moves_trusted() {
                let undo = make_reversible_move(&mut parent, mv).expect("legal move");
                assert_eq!(
                    parent.zobrist_hash(),
                    super::zobrist_hash(&parent),
                    "{fen} {mv:?}"
                );
                for reply in parent.legal_moves_trusted() {
                    let child = parent.after_known_legal_move(reply).expect("legal reply");
                    assert_eq!(
                        child.zobrist_hash(),
                        super::zobrist_hash(&child),
                        "{fen} {mv:?} {reply:?}"
                    );
                }
                unmake_reversible_move(&mut parent, undo);
                assert_eq!(parent.zobrist_hash(), super::zobrist_hash(&parent));
            }
        }
    }
}
