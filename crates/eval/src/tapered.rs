//! Allocation-free, white-relative tapered Classical evaluation.
//!
//! PeSTO material/PST seed: Ronald Friederich (Rofchade), published at
//! www.chessprogramming.org/PeSTO%27s_Evaluation_Function .
//! PST indices run a1..h8 for White; Black flips ranks (square ^ 56).
//! All terms are linear in the weights, including king-zone pressure. Phase
//! counts N/B=1, R=2, Q=4 for both sides and saturates at 24 after promotions.

use chess_board::{Color, PieceKind, Position};

pub const MATERIAL: usize = 0;
pub const PST: usize = MATERIAL + 6;
pub const BISHOP_PAIR: usize = PST + 6 * 64;
pub const MOBILITY: usize = BISHOP_PAIR + 1;
pub const PASSED_PAWN: usize = MOBILITY + 6;
pub const DOUBLED_PAWN: usize = PASSED_PAWN + 8;
pub const ISOLATED_PAWN: usize = DOUBLED_PAWN + 1;
pub const ROOK_OPEN: usize = ISOLATED_PAWN + 1;
pub const ROOK_SEMI_OPEN: usize = ROOK_OPEN + 1;
pub const KING_ATTACK: usize = ROOK_SEMI_OPEN + 1;
pub const PAWN_SHIELD: usize = KING_ATTACK + 5;
pub const TEMPO: usize = PAWN_SHIELD + 1;
/// Our pawns attacking an enemy knight, bishop, rook or queen.
pub const THREAT_PAWN: usize = TEMPO + 1;
/// Our minors attacking an enemy pawn, knight, bishop, rook or queen that no enemy pawn guards.
pub const THREAT_MINOR: usize = THREAT_PAWN + 4;
/// Same as `THREAT_MINOR`, for our rooks.
pub const THREAT_ROOK: usize = THREAT_MINOR + 5;
/// Enemy knights, bishops, rooks and queens that we attack and nothing of theirs guards.
pub const HANGING: usize = THREAT_ROOK + 5;
/// Safe single pawn pushes that would attack an enemy knight, bishop, rook or queen.
pub const PUSH_THREAT: usize = HANGING + 1;
/// Number of our knights, bishops, rooks and queens that attack the enemy king zone.
pub const KING_ATTACKERS: usize = PUSH_THREAT + 1;
/// Indicator for 1, 2, 3 and 4+ attackers of the enemy king zone.
pub const KING_ATTACKER_COUNT: usize = KING_ATTACKERS + 4;
/// Knight, bishop, rook and queen having a safe square from which it would check.
pub const SAFE_CHECK: usize = KING_ATTACKER_COUNT + 4;
/// Files next to (and including) our king with no pawn of either color / only an enemy pawn.
pub const KING_FILE_OPEN: usize = SAFE_CHECK + 4;
pub const KING_FILE_SEMI: usize = KING_FILE_OPEN + 1;
/// Passed pawns by relative rank: stop square empty, stop square not attacked.
pub const PASSED_FREE: usize = KING_FILE_SEMI + 1;
pub const PASSED_SAFE: usize = PASSED_FREE + 8;
/// Chebyshev distance from our king / the enemy king to the stop square, by relative rank.
pub const PASSED_KING_OWN: usize = PASSED_SAFE + 8;
pub const PASSED_KING_ENEMY: usize = PASSED_KING_OWN + 8;
/// Passed pawn guarded by a pawn or side by side with one, by relative rank.
pub const PASSED_CONNECTED: usize = PASSED_KING_ENEMY + 8;
/// The same for pawns that are not passed.
pub const PAWN_CONNECTED: usize = PASSED_CONNECTED + 8;
/// Knight or bishop guarded by a pawn on relative ranks 4-6 that no enemy pawn can attack.
pub const KNIGHT_OUTPOST: usize = PAWN_CONNECTED + 8;
pub const BISHOP_OUTPOST: usize = KNIGHT_OUTPOST + 1;
/// Rook on the relative seventh with the enemy king on the eighth or enemy pawns on the seventh.
pub const ROOK_SEVENTH: usize = BISHOP_OUTPOST + 1;
/// Mobility by exact square count (same area as `MOBILITY`), on top of the linear term.
pub const MOBILITY_KNIGHT: usize = ROOK_SEVENTH + 1;
pub const MOBILITY_BISHOP: usize = MOBILITY_KNIGHT + 9;
pub const MOBILITY_ROOK: usize = MOBILITY_BISHOP + 14;
pub const MOBILITY_QUEEN: usize = MOBILITY_ROOK + 15;
/// Pawn that cannot be guarded by a neighbour and whose stop square an enemy pawn
/// attacks; `[enemy pawn on its file, file free of enemy pawns]`.
pub const PAWN_BACKWARD: usize = MOBILITY_QUEEN + 28;
/// Own pawn in front of the king per file: `[off or on the king file][rank distance, 7 none]`.
pub const KING_SHELTER: usize = PAWN_BACKWARD + 2;
/// Nearest enemy pawn in front of the king per file: `[free or blocked by ours][rank distance]`.
pub const KING_STORM: usize = KING_SHELTER + 16;
/// Knight, then bishop, directly behind a pawn of either colour.
pub const MINOR_BEHIND_PAWN: usize = KING_STORM + 16;
/// Per bishop, own pawns on its square colour that an enemy pawn blocks head-on.
pub const BISHOP_RAMMED: usize = MINOR_BEHIND_PAWN + 2;
/// Bishop on a long diagonal, off the centre, seeing two centre squares through pawns.
pub const BISHOP_LONG_DIAGONAL: usize = BISHOP_RAMMED + 1;
pub const PARAM_COUNT: usize = BISHOP_LONG_DIAGONAL + 1;
/// Parameters that predate the threat, king-safety, passer, outpost and mobility-table terms.
pub const CORE_PARAM_COUNT: usize = TEMPO + 1;
pub const MAX_PHASE: i32 = 24;

/// Indexed terms, each [midgame, endgame] in centipawns. Piece order throughout
/// is pawn, knight, bishop, rook, queen, king. Structural penalties are negative.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EvalParams {
    pub weights: [[i32; 2]; PARAM_COUNT],
}

/// Appends zero rows for the terms added after the original tuning.
const fn pad(core: [[i32; 2]; CORE_PARAM_COUNT]) -> [[i32; 2]; PARAM_COUNT] {
    let mut weights = [[0; 2]; PARAM_COUNT];
    let mut i = 0;
    while i < CORE_PARAM_COUNT {
        weights[i] = core[i];
        i += 1;
    }
    weights
}

/// Reproducible untuned baseline: PeSTO material/PSTs and hand-set extra terms.
pub const START_PARAMS: EvalParams = EvalParams {
    weights: pad([
        [82, 94],    // pawn material
        [337, 281],  // knight material
        [365, 297],  // bishop material
        [477, 512],  // rook material
        [1025, 936], // queen material
        [0, 0],      // king material
        [0, 0],      // pawn PST a1..h8
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
        [-35, 13],
        [-1, 8],
        [-20, 8],
        [-23, 10],
        [-15, 13],
        [24, 0],
        [38, 2],
        [-22, -7],
        [-26, 4],
        [-4, 7],
        [-4, -6],
        [-10, 1],
        [3, 0],
        [3, -5],
        [33, -1],
        [-12, -8],
        [-27, 13],
        [-2, 9],
        [-5, -3],
        [12, -7],
        [17, -7],
        [6, -8],
        [10, 3],
        [-25, -1],
        [-14, 32],
        [13, 24],
        [6, 13],
        [21, 5],
        [23, -2],
        [12, 4],
        [17, 17],
        [-23, 17],
        [-6, 94],
        [7, 100],
        [26, 85],
        [31, 67],
        [65, 56],
        [56, 53],
        [25, 82],
        [-20, 84],
        [98, 178],
        [134, 173],
        [61, 158],
        [95, 134],
        [68, 147],
        [126, 132],
        [34, 165],
        [-11, 187],
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
        [-105, -29], // knight PST a1..h8
        [-21, -51],
        [-58, -23],
        [-33, -15],
        [-17, -22],
        [-28, -18],
        [-19, -50],
        [-23, -64],
        [-29, -42],
        [-53, -20],
        [-12, -10],
        [-3, -5],
        [-1, -2],
        [18, -20],
        [-14, -23],
        [-19, -44],
        [-23, -23],
        [-9, -3],
        [12, -1],
        [10, 15],
        [19, 10],
        [17, -3],
        [25, -20],
        [-16, -22],
        [-13, -18],
        [4, -6],
        [16, 16],
        [13, 25],
        [28, 16],
        [19, 17],
        [21, 4],
        [-8, -18],
        [-9, -17],
        [17, 3],
        [19, 22],
        [53, 22],
        [37, 22],
        [69, 11],
        [18, 8],
        [22, -18],
        [-47, -24],
        [60, -20],
        [37, 10],
        [65, 9],
        [84, -1],
        [129, -9],
        [73, -19],
        [44, -41],
        [-73, -25],
        [-41, -8],
        [72, -25],
        [36, -2],
        [23, -9],
        [62, -25],
        [7, -24],
        [-17, -52],
        [-167, -58],
        [-89, -38],
        [-34, -13],
        [-49, -28],
        [61, -31],
        [-97, -27],
        [-15, -63],
        [-107, -99],
        [-33, -23], // bishop PST a1..h8
        [-3, -9],
        [-14, -23],
        [-21, -5],
        [-13, -9],
        [-12, -16],
        [-39, -5],
        [-21, -17],
        [4, -14],
        [15, -18],
        [16, -7],
        [0, -1],
        [7, 4],
        [21, -9],
        [33, -15],
        [1, -27],
        [0, -12],
        [15, -3],
        [15, 8],
        [15, 10],
        [14, 13],
        [27, 3],
        [18, -7],
        [10, -15],
        [-6, -6],
        [13, 3],
        [13, 13],
        [26, 19],
        [34, 7],
        [12, 10],
        [10, -3],
        [4, -9],
        [-4, -3],
        [5, 9],
        [19, 12],
        [50, 9],
        [37, 14],
        [37, 10],
        [7, 3],
        [-2, 2],
        [-16, 2],
        [37, -8],
        [43, 0],
        [40, -1],
        [35, -2],
        [50, 6],
        [37, 0],
        [-2, 4],
        [-26, -8],
        [16, -4],
        [-18, 7],
        [-13, -12],
        [30, -3],
        [59, -13],
        [18, -4],
        [-47, -14],
        [-29, -14],
        [4, -21],
        [-82, -11],
        [-37, -8],
        [-25, -7],
        [-42, -9],
        [7, -17],
        [-8, -24],
        [-19, -9], // rook PST a1..h8
        [-13, 2],
        [1, 3],
        [17, -1],
        [16, -5],
        [7, -13],
        [-37, 4],
        [-26, -20],
        [-44, -6],
        [-16, -6],
        [-20, 0],
        [-9, 2],
        [-1, -9],
        [11, -9],
        [-6, -11],
        [-71, -3],
        [-45, -4],
        [-25, 0],
        [-16, -5],
        [-17, -1],
        [3, -7],
        [0, -12],
        [-5, -8],
        [-33, -16],
        [-36, 3],
        [-26, 5],
        [-12, 8],
        [-1, 4],
        [9, -5],
        [-7, -6],
        [6, -8],
        [-23, -11],
        [-24, 4],
        [-11, 3],
        [7, 13],
        [26, 1],
        [24, 2],
        [35, 1],
        [-8, -1],
        [-20, 2],
        [-5, 7],
        [19, 7],
        [26, 7],
        [36, 5],
        [17, 4],
        [45, -3],
        [61, -5],
        [16, -3],
        [27, 11],
        [32, 13],
        [58, 13],
        [62, 11],
        [80, -3],
        [67, 3],
        [26, 8],
        [44, 3],
        [32, 13],
        [42, 10],
        [32, 18],
        [51, 15],
        [63, 12],
        [9, 12],
        [31, 8],
        [43, 5],
        [-1, -33], // queen PST a1..h8
        [-18, -28],
        [-9, -22],
        [10, -43],
        [-15, -5],
        [-25, -32],
        [-31, -20],
        [-50, -41],
        [-35, -22],
        [-8, -23],
        [11, -30],
        [2, -16],
        [8, -16],
        [15, -23],
        [-3, -36],
        [1, -32],
        [-14, -16],
        [2, -27],
        [-11, 15],
        [-2, 6],
        [-5, 9],
        [2, 17],
        [14, 10],
        [5, 5],
        [-9, -18],
        [-26, 28],
        [-9, 19],
        [-10, 47],
        [-2, 31],
        [-4, 34],
        [3, 39],
        [-3, 23],
        [-27, 3],
        [-27, 22],
        [-16, 24],
        [-16, 45],
        [-1, 57],
        [17, 40],
        [-2, 57],
        [1, 36],
        [-13, -20],
        [-17, 6],
        [7, 9],
        [8, 49],
        [29, 47],
        [56, 35],
        [47, 19],
        [57, 9],
        [-24, -17],
        [-39, 20],
        [-5, 32],
        [1, 41],
        [-16, 58],
        [57, 25],
        [28, 30],
        [54, 0],
        [-28, -9],
        [0, 22],
        [29, 22],
        [12, 27],
        [59, 27],
        [44, 19],
        [43, 10],
        [45, 20],
        [-15, -53], // king PST a1..h8
        [36, -34],
        [12, -21],
        [-54, -11],
        [8, -28],
        [-28, -14],
        [24, -24],
        [14, -43],
        [1, -27],
        [7, -11],
        [-8, 4],
        [-64, 13],
        [-43, 14],
        [-16, 4],
        [9, -5],
        [8, -17],
        [-14, -19],
        [-14, -3],
        [-22, 11],
        [-46, 21],
        [-44, 23],
        [-30, 16],
        [-15, 7],
        [-27, -9],
        [-49, -18],
        [-1, -4],
        [-27, 21],
        [-39, 24],
        [-46, 27],
        [-44, 23],
        [-33, 9],
        [-51, -11],
        [-17, -8],
        [-20, 22],
        [-12, 24],
        [-27, 27],
        [-30, 26],
        [-25, 33],
        [-14, 26],
        [-36, 3],
        [-9, 10],
        [24, 17],
        [2, 23],
        [-16, 15],
        [-20, 20],
        [6, 45],
        [22, 44],
        [-22, 13],
        [29, -12],
        [-1, 17],
        [-20, 14],
        [-7, 17],
        [-8, 17],
        [-4, 38],
        [-38, 23],
        [-29, 11],
        [-65, -74],
        [23, -35],
        [16, -18],
        [-15, -18],
        [-56, -11],
        [-34, 15],
        [2, 4],
        [13, -17],
        [30, 45], // bishop pair
        [0, 0],   // mobility P/N/B/R/Q/K
        [4, 4],
        [4, 5],
        [2, 4],
        [1, 2],
        [0, 0],
        [0, 0], // passed pawns by relative rank 1..8
        [0, 0],
        [5, 10],
        [10, 20],
        [20, 40],
        [40, 70],
        [70, 120],
        [0, 0],
        [-12, -20], // doubled pawn
        [-15, -12], // isolated pawn
        [20, 10],   // open rook file
        [10, 5],    // semi-open rook file
        [2, 0],     // king-zone pressure P/N/B/R/Q
        [5, 0],
        [5, 0],
        [7, 0],
        [10, 0],
        [8, 0],   // pawn shield
        [15, 10], // tempo
    ]),
};

/// Replaced by the offline Texel tuning output; no data or I/O at runtime.
// Texel: K=1.523672357, quiet=2246488, train MSE 0.053628870 -> 0.053309470, held-out MSE 0.053987779 -> 0.053651039.
pub const DEFAULT_PARAMS: EvalParams = EvalParams {
    weights: [
        [67, 84],    // 0
        [293, 333],  // 1
        [312, 332],  // 2
        [398, 606],  // 3
        [944, 1076], // 4
        [0, 0],      // 5
        [0, 0],      // 6
        [0, 0],      // 7
        [0, 0],      // 8
        [0, 0],      // 9
        [0, 0],      // 10
        [0, 0],      // 11
        [0, 0],      // 12
        [0, 0],      // 13
        [-22, 36],   // 14
        [-6, 32],    // 15
        [4, 22],     // 16
        [-2, 22],    // 17
        [5, 29],     // 18
        [27, 19],    // 19
        [18, 19],    // 20
        [-26, 24],   // 21
        [-29, 30],   // 22
        [-15, 25],   // 23
        [-4, 18],    // 24
        [-2, 18],    // 25
        [5, 16],     // 26
        [4, 16],     // 27
        [1, 15],     // 28
        [-25, 18],   // 29
        [-19, 36],   // 30
        [-14, 33],   // 31
        [0, 19],     // 32
        [15, 11],    // 33
        [17, 11],    // 34
        [8, 16],     // 35
        [-9, 23],    // 36
        [-26, 22],   // 37
        [-13, 43],   // 38
        [-3, 32],    // 39
        [7, 22],     // 40
        [5, 11],     // 41
        [16, 11],    // 42
        [17, 15],    // 43
        [-4, 28],    // 44
        [-13, 25],   // 45
        [28, 36],    // 46
        [23, 46],    // 47
        [30, 30],    // 48
        [20, 25],    // 49
        [-11, 30],   // 50
        [53, 29],    // 51
        [40, 44],    // 52
        [11, 39],    // 53
        [107, 54],   // 54
        [151, 25],   // 55
        [133, 62],   // 56
        [175, 36],   // 57
        [94, 51],    // 58
        [137, 31],   // 59
        [-12, 75],   // 60
        [-11, 72],   // 61
        [0, 0],      // 62
        [0, 0],      // 63
        [0, 0],      // 64
        [0, 0],      // 65
        [0, 0],      // 66
        [0, 0],      // 67
        [0, 0],      // 68
        [0, 0],      // 69
        [-74, -1],   // 70
        [-34, -2],   // 71
        [-48, 8],    // 72
        [-7, 11],    // 73
        [-20, 15],   // 74
        [-12, 1],    // 75
        [-30, 0],    // 76
        [-11, -12],  // 77
        [-45, 0],    // 78
        [-54, 5],    // 79
        [-15, 10],   // 80
        [-7, 14],    // 81
        [-4, 12],    // 82
        [-6, 7],     // 83
        [-9, -5],    // 84
        [-23, 3],    // 85
        [-35, 7],    // 86
        [-20, 11],   // 87
        [-10, 20],   // 88
        [-9, 30],    // 89
        [3, 29],     // 90
        [-3, 15],    // 91
        [4, 6],      // 92
        [-18, 8],    // 93
        [-14, 10],   // 94
        [6, 15],     // 95
        [5, 28],     // 96
        [12, 31],    // 97
        [9, 37],     // 98
        [16, 22],    // 99
        [17, 10],    // 100
        [-4, 8],     // 101
        [-6, 11],    // 102
        [9, 16],     // 103
        [9, 32],     // 104
        [29, 29],    // 105
        [21, 29],    // 106
        [41, 20],    // 107
        [9, 12],     // 108
        [7, 9],      // 109
        [-51, 14],   // 110
        [-1, 13],    // 111
        [11, 24],    // 112
        [6, 28],     // 113
        [43, 24],    // 114
        [29, 7],     // 115
        [6, 4],      // 116
        [-31, 0],    // 117
        [-17, 6],    // 118
        [-9, 12],    // 119
        [-1, 17],    // 120
        [31, 11],    // 121
        [-16, 12],   // 122
        [24, 7],     // 123
        [-32, 17],   // 124
        [0, -8],     // 125
        [-151, -42], // 126
        [-133, -8],  // 127
        [-31, 2],    // 128
        [-10, -9],   // 129
        [123, -27],  // 130
        [-48, -15],  // 131
        [-100, -8],  // 132
        [-108, -59], // 133
        [-25, -3],   // 134
        [-13, 32],   // 135
        [-17, 17],   // 136
        [-18, 14],   // 137
        [-16, 15],   // 138
        [-26, 21],   // 139
        [-43, 17],   // 140
        [-8, -7],    // 141
        [-24, 16],   // 142
        [-19, -3],   // 143
        [2, 3],      // 144
        [-7, 11],    // 145
        [-3, 11],    // 146
        [5, 4],      // 147
        [2, -6],     // 148
        [-4, 0],     // 149
        [-22, 16],   // 150
        [1, 14],     // 151
        [-15, 9],    // 152
        [-3, 18],    // 153
        [5, 16],     // 154
        [-8, 8],     // 155
        [-2, 14],    // 156
        [16, 0],     // 157
        [-29, 18],   // 158
        [-27, 25],   // 159
        [1, 19],     // 160
        [29, 17],    // 161
        [17, 17],    // 162
        [-2, 22],    // 163
        [-18, 19],   // 164
        [-1, 10],    // 165
        [4, 12],     // 166
        [4, 20],     // 167
        [-6, 23],    // 168
        [15, 25],    // 169
        [17, 22],    // 170
        [13, 22],    // 171
        [15, 19],    // 172
        [1, 8],      // 173
        [-7, 20],    // 174
        [0, 13],     // 175
        [-13, 13],   // 176
        [-5, 19],    // 177
        [-5, 19],    // 178
        [37, 8],     // 179
        [28, 10],    // 180
        [2, 11],     // 181
        [-11, 6],    // 182
        [-42, 13],   // 183
        [-8, 17],    // 184
        [18, 18],    // 185
        [-12, 10],   // 186
        [9, 12],     // 187
        [-29, 10],   // 188
        [-16, 6],    // 189
        [-20, 6],    // 190
        [-6, 16],    // 191
        [-23, 12],   // 192
        [-28, 19],   // 193
        [-78, 19],   // 194
        [-58, 16],   // 195
        [-37, 9],    // 196
        [-58, 9],    // 197
        [-13, 22],   // 198
        [-8, 27],    // 199
        [-8, 33],    // 200
        [-6, 28],    // 201
        [3, 20],     // 202
        [1, 20],     // 203
        [-4, 26],    // 204
        [-19, 25],   // 205
        [-21, 22],   // 206
        [-12, 24],   // 207
        [-9, 28],    // 208
        [-4, 25],    // 209
        [-7, 20],    // 210
        [-1, 15],    // 211
        [0, 15],     // 212
        [-23, 13],   // 213
        [-26, 31],   // 214
        [-30, 36],   // 215
        [-24, 33],   // 216
        [-25, 37],   // 217
        [-19, 30],   // 218
        [-1, 24],    // 219
        [2, 18],     // 220
        [-12, 21],   // 221
        [-15, 34],   // 222
        [-29, 41],   // 223
        [-16, 41],   // 224
        [-20, 41],   // 225
        [-2, 32],    // 226
        [-11, 34],   // 227
        [2, 39],     // 228
        [-6, 29],    // 229
        [-16, 45],   // 230
        [9, 37],     // 231
        [-11, 51],   // 232
        [-17, 47],   // 233
        [-4, 36],    // 234
        [35, 18],    // 235
        [12, 40],    // 236
        [1, 34],     // 237
        [3, 38],     // 238
        [19, 37],    // 239
        [12, 37],    // 240
        [-12, 43],   // 241
        [21, 34],    // 242
        [52, 21],    // 243
        [45, 31],    // 244
        [27, 24],    // 245
        [7, 22],     // 246
        [10, 29],    // 247
        [29, 29],    // 248
        [38, 22],    // 249
        [26, 25],    // 250
        [52, 23],    // 251
        [78, 11],    // 252
        [73, 3],     // 253
        [-22, 43],   // 254
        [-58, 58],   // 255
        [-16, 51],   // 256
        [-37, 57],   // 257
        [-37, 49],   // 258
        [14, 43],    // 259
        [-17, 49],   // 260
        [-6, 41],    // 261
        [-28, 15],   // 262
        [-8, -14],   // 263
        [-5, 5],     // 264
        [-12, 13],   // 265
        [-13, 14],   // 266
        [-24, 13],   // 267
        [-15, 15],   // 268
        [-8, -27],   // 269
        [2, -16],    // 270
        [-10, 14],   // 271
        [4, -1],     // 272
        [0, 24],     // 273
        [0, 19],     // 274
        [15, -17],   // 275
        [-9, 7],     // 276
        [19, -27],   // 277
        [18, -19],   // 278
        [-7, 38],    // 279
        [2, 36],     // 280
        [-2, 21],    // 281
        [-5, 42],    // 282
        [-1, 27],    // 283
        [25, 6],     // 284
        [6, 26],     // 285
        [8, -8],     // 286
        [-7, 41],    // 287
        [7, 27],     // 288
        [-2, 67],    // 289
        [10, 33],    // 290
        [-4, 53],    // 291
        [-4, 50],    // 292
        [14, 29],    // 293
        [-8, 36],    // 294
        [0, 39],     // 295
        [24, 15],    // 296
        [-9, 62],    // 297
        [-1, 55],    // 298
        [19, 36],    // 299
        [25, 34],    // 300
        [19, 41],    // 301
        [19, 27],    // 302
        [6, 26],     // 303
        [-6, 53],    // 304
        [18, 41],    // 305
        [-18, 82],   // 306
        [33, 6],     // 307
        [22, 24],    // 308
        [24, 24],    // 309
        [4, 10],     // 310
        [-17, 43],   // 311
        [-15, 56],   // 312
        [-70, 102],  // 313
        [-33, 82],   // 314
        [-15, 52],   // 315
        [31, 8],     // 316
        [66, 3],     // 317
        [-14, 8],    // 318
        [-64, 43],   // 319
        [-6, 35],    // 320
        [-71, 79],   // 321
        [6, 34],     // 322
        [-3, 25],    // 323
        [-46, 34],   // 324
        [-18, 12],   // 325
        [-17, -37],  // 326
        [17, -21],   // 327
        [0, -1],     // 328
        [-51, 9],    // 329
        [-21, 3],    // 330
        [-48, 7],    // 331
        [-13, -10],  // 332
        [-19, -32],  // 333
        [5, -28],    // 334
        [10, -16],   // 335
        [15, -7],    // 336
        [-4, 0],     // 337
        [0, 2],      // 338
        [0, -3],     // 339
        [13, -12],   // 340
        [-3, -18],   // 341
        [5, -26],    // 342
        [25, -15],   // 343
        [14, -2],    // 344
        [4, 8],      // 345
        [16, 5],     // 346
        [9, -3],     // 347
        [17, -13],   // 348
        [-47, -4],   // 349
        [-54, -14],  // 350
        [6, -6],     // 351
        [-1, 8],     // 352
        [-46, 24],   // 353
        [-25, 18],   // 354
        [-3, 6],     // 355
        [6, -2],     // 356
        [-65, 0],    // 357
        [-18, -14],  // 358
        [1, 0],      // 359
        [-20, 19],   // 360
        [-42, 28],   // 361
        [-26, 29],   // 362
        [-15, 22],   // 363
        [24, 9],     // 364
        [-66, 11],   // 365
        [-52, -9],   // 366
        [75, -5],    // 367
        [14, 17],    // 368
        [-11, 30],   // 369
        [27, 31],    // 370
        [53, 20],    // 371
        [105, 5],    // 372
        [18, 2],     // 373
        [-70, -14],  // 374
        [26, -5],    // 375
        [9, 13],     // 376
        [52, -1],    // 377
        [45, 12],    // 378
        [59, 17],    // 379
        [108, 2],    // 380
        [43, -2],    // 381
        [34, -71],   // 382
        [39, -37],   // 383
        [45, -19],   // 384
        [10, 1],     // 385
        [10, -6],    // 386
        [-51, 5],    // 387
        [30, -11],   // 388
        [88, -78],   // 389
        [21, 58],    // 390
        [-5, -1],    // 391
        [8, 3],      // 392
        [5, 5],      // 393
        [0, 4],      // 394
        [8, 0],      // 395
        [-3, 4],     // 396
        [0, 0],      // 397
        [31, -9],    // 398
        [-14, 14],   // 399
        [-17, 14],   // 400
        [50, 13],    // 401
        [223, -42],  // 402
        [347, -86],  // 403
        [0, 0],      // 404
        [1, -19],    // 405
        [-8, -7],    // 406
        [38, -4],    // 407
        [13, 2],     // 408
        [27, -15],   // 409
        [9, -12],    // 410
        [17, -7],    // 411
        [12, 6],     // 412
        [30, -4],    // 413
        [2, -5],     // 414
        [45, 28],    // 415
        [71, 14],    // 416
        [35, 103],   // 417
        [58, -4],    // 418
        [82, -134],  // 419
        [-3, 22],    // 420
        [18, 14],    // 421
        [23, 23],    // 422
        [71, -2],    // 423
        [58, -54],   // 424
        [-5, 26],    // 425
        [6, 27],     // 426
        [7, 31],     // 427
        [40, -109],  // 428
        [-36, -37],  // 429
        [22, 10],    // 430
        [24, 9],     // 431
        [24, 3],     // 432
        [4, 6],      // 433
        [13, -32],   // 434
        [-12, 8],    // 435
        [-24, 5],    // 436
        [-10, 2],    // 437
        [29, 2],     // 438
        [132, -99],  // 439
        [105, 0],    // 440
        [35, 15],    // 441
        [89, -8],    // 442
        [37, 49],    // 443
        [-13, -24],  // 444
        [-8, -4],    // 445
        [0, 0],      // 446
        [-15, 15],   // 447
        [-19, 6],    // 448
        [-13, 18],   // 449
        [-10, 33],   // 450
        [-26, 86],   // 451
        [-118, 180], // 452
        [0, 0],      // 453
        [0, 0],      // 454
        [-11, 5],    // 455
        [-9, 1],     // 456
        [-20, 12],   // 457
        [-40, 34],   // 458
        [-66, 93],   // 459
        [-55, 167],  // 460
        [0, 0],      // 461
        [0, 0],      // 462
        [-6, 1],     // 463
        [-6, -2],    // 464
        [6, -11],    // 465
        [3, -17],    // 466
        [-8, -20],   // 467
        [-29, -16],  // 468
        [0, 0],      // 469
        [0, 0],      // 470
        [1, 0],      // 471
        [9, 0],      // 472
        [-4, 11],    // 473
        [-12, 24],   // 474
        [-35, 43],   // 475
        [-11, 36],   // 476
        [0, 0],      // 477
        [0, 0],      // 478
        [15, -11],   // 479
        [24, 3],     // 480
        [19, 14],    // 481
        [23, 32],    // 482
        [69, 71],    // 483
        [239, 49],   // 484
        [0, 0],      // 485
        [0, 0],      // 486
        [2, -1],     // 487
        [10, 5],     // 488
        [12, 6],     // 489
        [13, 16],    // 490
        [20, 32],    // 491
        [0, 0],      // 492
        [0, 0],      // 493
        [20, 11],    // 494
        [45, -9],    // 495
        [-7, 24],    // 496
        [-6, -38],   // 497
        [0, -16],    // 498
        [9, 2],      // 499
        [5, 1],      // 500
        [1, 6],      // 501
        [-1, 8],     // 502
        [-1, 3],     // 503
        [-2, -3],    // 504
        [-7, -11],   // 505
        [0, -11],    // 506
        [5, -4],     // 507
        [6, 8],      // 508
        [6, 10],     // 509
        [5, 10],     // 510
        [2, 13],     // 511
        [2, 10],     // 512
        [-3, 8],     // 513
        [-4, 5],     // 514
        [1, -4],     // 515
        [5, -10],    // 516
        [-3, -14],   // 517
        [-47, 0],    // 518
        [-9, -31],   // 519
        [-3, -12],   // 520
        [4, 0],      // 521
        [6, -2],     // 522
        [9, 2],      // 523
        [2, 5],      // 524
        [4, 5],      // 525
        [5, 7],      // 526
        [3, 8],      // 527
        [10, 4],     // 528
        [-1, 6],     // 529
        [5, 3],      // 530
        [0, 3],      // 531
        [-3, 2],     // 532
        [-7, 1],     // 533
        [-14, -3],   // 534
        [45, -94],   // 535
        [41, -97],   // 536
        [27, -15],   // 537
        [19, -10],   // 538
        [16, 2],     // 539
        [10, 1],     // 540
        [1, 25],     // 541
        [-8, 42],    // 542
        [-13, 43],   // 543
        [-18, 35],   // 544
        [-25, 39],   // 545
        [-28, 44],   // 546
        [-37, 43],   // 547
        [-46, 52],   // 548
        [-44, 40],   // 549
        [-50, 41],   // 550
        [-54, 39],   // 551
        [-70, 48],   // 552
        [-56, 38],   // 553
        [-15, 1],    // 554
        [-32, 18],   // 555
        [30, -25],   // 556
        [-15, -8],   // 557
        [22, -36],   // 558
        [49, -35],   // 559
        [141, -106], // 560
        [198, -121], // 561
        [51, -61],   // 562
        [-2, -6],    // 563
        [-24, -19],  // 564
        [0, 0],      // 565
        [4, -3],     // 566
        [0, -4],     // 567
        [7, -15],    // 568
        [4, -15],    // 569
        [-27, 16],   // 570
        [-15, 69],   // 571
        [-2, 4],     // 572
        [0, 0],      // 573
        [16, -6],    // 574
        [10, -3],    // 575
        [6, -16],    // 576
        [1, -13],    // 577
        [-88, 31],   // 578
        [-2, 72],    // 579
        [-17, 7],    // 580
        [0, 0],      // 581
        [59, -18],   // 582
        [12, -17],   // 583
        [-11, 4],    // 584
        [1, 2],      // 585
        [4, 0],      // 586
        [3, 4],      // 587
        [-7, 12],    // 588
        [0, 0],      // 589
        [0, 0],      // 590
        [22, -21],   // 591
        [0, 0],      // 592
        [0, 4],      // 593
        [3, -1],     // 594
        [60, -36],   // 595
        [-31, 14],   // 596
        [6, 14],     // 597
        [5, 15],     // 598
        [-4, -15],   // 599
        [23, 8],     // 600
    ],
};

/// Sparse, integer feature counts before phase blending. Allocated only by the
/// offline tuner, never by evaluation. `phase` is in 0..=24.
#[derive(Clone, Debug)]
pub struct Trace {
    pub phase: u8,
    /// Endgame scale in 128ths when White's, then Black's, endgame score leads.
    pub scales: [i32; 2],
    pub coefficients: Vec<(usize, i16)>,
}

impl Trace {
    /// Endgame scale in 128ths under `params`, as the runtime picks it.
    #[must_use]
    pub fn scale(&self, params: &EvalParams) -> i32 {
        let eg: i32 = self
            .coefficients
            .iter()
            .map(|&(index, count)| i32::from(count) * params.weights[index][1])
            .sum();
        self.scales[usize::from(eg < 0)]
    }

    /// Unrounded score, for checking the tuner's linear model against runtime.
    #[must_use]
    pub fn evaluate(&self, params: &EvalParams) -> f64 {
        let phase = f64::from(self.phase) / f64::from(MAX_PHASE);
        let eg_weight = (1.0 - phase) * f64::from(self.scale(params)) / f64::from(SCALE_NORMAL);
        self.coefficients
            .iter()
            .map(|&(index, count)| {
                let [mg, eg] = params.weights[index];
                f64::from(count) * (f64::from(mg) * phase + f64::from(eg) * eg_weight)
            })
            .sum()
    }
}

#[must_use]
pub fn trace(position: &Position) -> Trace {
    let mut sink = Counts([0; PARAM_COUNT]);
    let phase = features(position, &mut sink);
    Trace {
        phase: phase as u8,
        scales: [scale_factor(position, 0), scale_factor(position, -1)],
        coefficients: sink
            .0
            .into_iter()
            .enumerate()
            .filter(|&(_, c)| c != 0)
            .collect(),
    }
}

/// White-relative centipawns; the side-to-move tempo also changes sign.
#[must_use]
pub fn evaluate_tapered(position: &Position) -> i32 {
    evaluate_packed(position, &DEFAULT_PACKED)
}

/// Same feature extraction as `trace`, using an integer accumulator on the stack.
#[must_use]
pub fn evaluate_with_params(position: &Position, params: &EvalParams) -> i32 {
    evaluate_packed(position, &pack(params))
}

/// Midgame in the low 32 bits and endgame in the high 32, so one multiply-add
/// per feature updates both phases. Decoded exactly while totals stay in i32.
const fn pack(params: &EvalParams) -> [i64; PARAM_COUNT] {
    let mut packed = [0; PARAM_COUNT];
    let mut i = 0;
    while i < PARAM_COUNT {
        packed[i] = params.weights[i][0] as i64 + ((params.weights[i][1] as i64) << 32);
        i += 1;
    }
    packed
}

const DEFAULT_PACKED: [i64; PARAM_COUNT] = pack(&DEFAULT_PARAMS);

fn evaluate_packed(position: &Position, packed: &[i64; PARAM_COUNT]) -> i32 {
    let mut sink = Score { packed, sum: 0 };
    let phase = features(position, &mut sink);
    blend(position, sink.sum, phase)
}

fn blend(position: &Position, sum: i64, phase: i32) -> i32 {
    let mg = sum as i32;
    let eg = ((sum - i64::from(mg)) >> 32) as i32;
    let scale = scale_factor(position, eg);
    (mg * phase + eg * (MAX_PHASE - phase) * scale / SCALE_NORMAL) / MAX_PHASE
}

/// Pawn-and-king term sums keyed exactly by both pawn sets and both king squares, so a hit
/// returns the same packed sum [`pawn_king_features`] would compute.
pub struct PawnCache {
    entries: Vec<PawnEntry>,
}

#[derive(Clone, Copy)]
struct PawnEntry {
    pawns: [u64; 2],
    /// White's king square in the low byte, Black's in the next; `u16::MAX` marks an empty slot.
    kings: u16,
    sum: i64,
}

const PAWN_CACHE_SIZE: usize = 1 << 14;

impl PawnCache {
    #[must_use]
    pub fn new() -> Self {
        let empty = PawnEntry {
            pawns: [0; 2],
            kings: u16::MAX,
            sum: 0,
        };
        Self {
            entries: vec![empty; PAWN_CACHE_SIZE],
        }
    }
}

impl Default for PawnCache {
    fn default() -> Self {
        Self::new()
    }
}

/// [`evaluate_tapered`] with the pawn-and-king terms served from `cache`; same result.
pub fn evaluate_cached(position: &Position, cache: &mut PawnCache) -> i32 {
    let setup = setup(position);
    let pawns = [setup.pieces[0][0], setup.pieces[1][0]];
    let kings = (setup.kings[0] | setup.kings[1] << 8) as u16;
    let hash = (pawns[0] ^ pawns[1].rotate_left(32) ^ u64::from(kings))
        .wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let entry = &mut cache.entries[(hash >> 50) as usize];
    let mut sink = Score {
        packed: &DEFAULT_PACKED,
        sum: 0,
    };
    if entry.pawns == pawns && entry.kings == kings {
        sink.sum = entry.sum;
    } else {
        pawn_king_features(&setup, &mut sink);
        *entry = PawnEntry {
            pawns,
            kings,
            sum: sink.sum,
        };
    }
    let phase = piece_features(position, &setup, &mut sink);
    blend(position, sink.sum, phase)
}

/// The endgame score's weight in 128ths.
pub const SCALE_NORMAL: i32 = 128;

/// Shrinks the endgame score where material makes a win hard: opposite-coloured
/// bishops, a lone queen against pieces, a lone minor, few pawns (Ethereal's rules).
fn scale_factor(position: &Position, eg: i32) -> i32 {
    let count = |color, kind| position.piece_bitboard(color, kind).count_ones() as i32;
    let (strong, weak) = if eg >= 0 {
        (Color::White, Color::Black)
    } else {
        (Color::Black, Color::White)
    };
    let knights = |c| count(c, PieceKind::Knight);
    let rooks = |c| count(c, PieceKind::Rook);
    let queens = count(Color::White, PieceKind::Queen) + count(Color::Black, PieceKind::Queen);
    let pieces = |c| knights(c) + count(c, PieceKind::Bishop) + rooks(c);
    let white_bishops = position.piece_bitboard(Color::White, PieceKind::Bishop);
    let black_bishops = position.piece_bitboard(Color::Black, PieceKind::Bishop);
    if queens == 0
        && white_bishops.count_ones() == 1
        && black_bishops.count_ones() == 1
        && (white_bishops & DARK_SQUARES != 0) != (black_bishops & DARK_SQUARES != 0)
    {
        let (w, b) = (Color::White, Color::Black);
        match (knights(w), knights(b), rooks(w), rooks(b)) {
            (1, 1, 0, 0) => return 106,
            (0, 0, 1, 1) => return 96,
            (0, 0, 0, 0) => return 64,
            _ => {}
        }
    }
    if count(strong, PieceKind::Queen) == 1
        && queens == 1
        && pieces(strong) == 0
        && pieces(weak) >= 2
    {
        return 88;
    }
    let strong_pawns = count(strong, PieceKind::Pawn);
    if strong_pawns == 0
        && count(strong, PieceKind::Queen) == 0
        && rooks(strong) == 0
        && pieces(strong) == 1
    {
        return 0;
    }
    if queens == 0
        && pieces(strong) <= 1
        && pieces(weak) <= 1
        && strong_pawns - count(weak, PieceKind::Pawn) > 2
    {
        return 144;
    }
    (96 + 8 * strong_pawns).min(SCALE_NORMAL)
}

trait Accumulator {
    fn add(&mut self, index: usize, count: i32);
}

struct Counts([i16; PARAM_COUNT]);

impl Accumulator for Counts {
    #[inline(always)]
    fn add(&mut self, index: usize, count: i32) {
        self.0[index] += count as i16;
    }
}

struct Score<'a> {
    packed: &'a [i64; PARAM_COUNT],
    sum: i64,
}

impl Accumulator for Score<'_> {
    #[inline(always)]
    fn add(&mut self, index: usize, count: i32) {
        self.sum += self.packed[index] * i64::from(count);
    }
}

const FILE_A: u64 = 0x0101_0101_0101_0101;
const FILE_H: u64 = FILE_A << 7;
const RANK_8: u64 = 0xFF00_0000_0000_0000;
const PHASE: [i32; 6] = [0, 1, 1, 2, 4, 0];
const KINDS: [PieceKind; 6] = [
    PieceKind::Pawn,
    PieceKind::Knight,
    PieceKind::Bishop,
    PieceKind::Rook,
    PieceKind::Queen,
    PieceKind::King,
];
const KING_OFFSETS: [(i32, i32); 8] = [
    (1, 0),
    (-1, 0),
    (0, 1),
    (0, -1),
    (1, 1),
    (-1, 1),
    (1, -1),
    (-1, -1),
];
const KNIGHT_OFFSETS: [(i32, i32); 8] = [
    (1, 2),
    (2, 1),
    (-1, 2),
    (-2, 1),
    (1, -2),
    (2, -1),
    (-1, -2),
    (-2, -1),
];

const fn leaper_table(offsets: &[(i32, i32)]) -> [u64; 64] {
    let mut table = [0; 64];
    let mut sq = 0;
    while sq < 64 {
        let mut i = 0;
        while i < offsets.len() {
            let file = (sq % 8) as i32 + offsets[i].0;
            let rank = (sq / 8) as i32 + offsets[i].1;
            if file >= 0 && file < 8 && rank >= 0 && rank < 8 {
                table[sq] |= 1u64 << (rank * 8 + file);
            }
            i += 1;
        }
        sq += 1;
    }
    table
}

const KNIGHT_ATTACKS: [u64; 64] = leaper_table(&KNIGHT_OFFSETS);
const KING_ATTACKS: [u64; 64] = leaper_table(&KING_OFFSETS);

/// `LINES[line][square]`: the other squares of the rank, file, diagonal and
/// anti-diagonal through `square`.
const fn line_table() -> [[u64; 64]; 4] {
    let mut table = [[0; 64]; 4];
    let mut sq = 0;
    while sq < 64 {
        let mut other = 0;
        while other < 64 {
            if other != sq {
                let (f, r) = ((sq % 8) as i32, (sq / 8) as i32);
                let (of, or) = ((other % 8) as i32, (other / 8) as i32);
                if r == or {
                    table[0][sq] |= 1 << other;
                }
                if f == of {
                    table[1][sq] |= 1 << other;
                }
                if r - f == or - of {
                    table[2][sq] |= 1 << other;
                }
                if r + f == or + of {
                    table[3][sq] |= 1 << other;
                }
            }
            other += 1;
        }
        sq += 1;
    }
    table
}

const LINES: [[u64; 64]; 4] = line_table();

#[inline(always)]
fn pawn_attacks(pawns: u64, color: usize) -> u64 {
    if color == 0 {
        ((pawns & !FILE_A) << 7) | ((pawns & !FILE_H) << 9)
    } else {
        ((pawns & !FILE_H) >> 7) | ((pawns & !FILE_A) >> 9)
    }
}

/// Hyperbola quintessence along one line, up to and including the first blockers.
#[inline(always)]
fn line_attacks(line: usize, square: usize, occupied: u64) -> u64 {
    let mask = LINES[line][square];
    let blockers = occupied & mask;
    let bit = 1u64 << square;
    let forward = blockers.wrapping_sub(bit.wrapping_mul(2));
    let backward = blockers
        .reverse_bits()
        .wrapping_sub(bit.reverse_bits().wrapping_mul(2))
        .reverse_bits();
    (forward ^ backward) & mask
}

#[inline(always)]
fn bishop_attacks(square: usize, occupied: u64) -> u64 {
    line_attacks(2, square, occupied) | line_attacks(3, square, occupied)
}

#[inline(always)]
fn rook_attacks(square: usize, occupied: u64) -> u64 {
    line_attacks(0, square, occupied) | line_attacks(1, square, occupied)
}

/// Fills every square south of (and including) each set bit.
#[inline(always)]
fn south_fill(mut bits: u64) -> u64 {
    bits |= bits >> 8;
    bits |= bits >> 16;
    bits | (bits >> 32)
}

/// Fills every square north of (and including) each set bit.
#[inline(always)]
fn north_fill(mut bits: u64) -> u64 {
    bits |= bits << 8;
    bits |= bits << 16;
    bits | (bits << 32)
}

const MOBILITY_TABLE: [usize; 6] = [
    0,
    MOBILITY_KNIGHT,
    MOBILITY_BISHOP,
    MOBILITY_ROOK,
    MOBILITY_QUEEN,
    0,
];
/// Relative ranks 4-6, as absolute rank bits for White and for Black.
const DARK_SQUARES: u64 = 0xAA55_AA55_AA55_AA55;
const LONG_DIAGONALS: u64 = 0x8040_2010_0804_0201 | 0x0102_0408_1020_4080;
const CENTER: u64 = (1 << 27) | (1 << 28) | (1 << 35) | (1 << 36);
const OUTPOST_RANKS: [u64; 2] = [0x0000_FFFF_FF00_0000, 0x0000_00FF_FFFF_0000];

#[inline(always)]
fn chebyshev(a: usize, b: usize) -> i32 {
    let files = ((a & 7) as i32 - (b & 7) as i32).abs();
    let ranks = ((a >> 3) as i32 - (b >> 3) as i32).abs();
    files.max(ranks)
}

/// Piece squares, mobility, king-zone pressure, pawn-structure and the
/// position-wide terms. The first pass per color also collects attack maps, so
/// the second pass can score threats and king safety against the opponent's.
/// The bitboards every feature reads.
struct Setup {
    pieces: [[u64; 6]; 2],
    occupied: [u64; 2],
    all: u64,
    /// 64 when a side has no king.
    kings: [usize; 2],
}

fn setup(position: &Position) -> Setup {
    let mut pieces = [[0u64; 6]; 2];
    let mut occupied = [0; 2];
    for (color, side) in [Color::White, Color::Black].into_iter().enumerate() {
        for (kind, piece) in KINDS.into_iter().enumerate() {
            pieces[color][kind] = position.piece_bitboard(side, piece);
        }
        occupied[color] = pieces[color].iter().fold(0, |all, &bits| all | bits);
    }
    Setup {
        pieces,
        occupied,
        all: occupied[0] | occupied[1],
        kings: [
            pieces[0][5].trailing_zeros() as usize,
            pieces[1][5].trailing_zeros() as usize,
        ],
    }
}

/// `color`'s pawn captures toward the left and right file.
fn pawn_captures(pawns: u64, color: usize) -> (u64, u64) {
    if color == 0 {
        ((pawns & !FILE_A) << 7, (pawns & !FILE_H) << 9)
    } else {
        ((pawns & !FILE_H) >> 7, (pawns & !FILE_A) >> 9)
    }
}

fn king_zone(setup: &Setup, color: usize) -> u64 {
    let king = setup.kings[color];
    if king < 64 {
        KING_ATTACKS[king] | setup.pieces[color][5]
    } else {
        0
    }
}

fn passed_pawns(setup: &Setup, color: usize) -> u64 {
    let enemy = color ^ 1;
    let theirs = setup.pieces[enemy][0];
    let enemy_attacks = pawn_attacks(theirs, enemy);
    let blockers = if color == 0 {
        south_fill(theirs | enemy_attacks)
    } else {
        north_fill(theirs | enemy_attacks)
    };
    setup.pieces[color][0] & !blockers
}

fn connected_pawns(setup: &Setup, color: usize) -> u64 {
    let ours = setup.pieces[color][0];
    let phalanx = ours & (((ours & !FILE_H) << 1) | ((ours & !FILE_A) >> 1));
    ours & pawn_attacks(ours, color) | phalanx
}

/// Every term that depends only on the pawns and the king squares, which is what
/// [`PawnCache`] keys on.
fn pawn_king_features(setup: &Setup, sink: &mut impl Accumulator) {
    for color in 0..2 {
        let sign = if color == 0 { 1 } else { -1 };
        let enemy = color ^ 1;
        let ours = setup.pieces[color];
        let theirs = setup.pieces[enemy];
        let king = setup.kings[color];
        let enemy_king = setup.kings[enemy];

        sink.add(MATERIAL, sign * ours[0].count_ones() as i32);
        let mut remaining = ours[0];
        while remaining != 0 {
            let sq = remaining.trailing_zeros() as usize;
            remaining &= remaining - 1;
            sink.add(PST + (sq ^ (color * 56)), sign);
        }
        let (left, right) = pawn_captures(ours[0], color);
        let zone = king_zone(setup, enemy);
        sink.add(
            KING_ATTACK,
            sign * ((left & zone).count_ones() + (right & zone).count_ones()) as i32,
        );

        if king < 64 {
            // Shield on the three files, one or two ranks in front of
            // our king. Enemy pawns never count as shelter.
            let front = pawn_attacks(1u64 << king, color)
                | if color == 0 {
                    (1u64 << king) << 8
                } else {
                    (1u64 << king) >> 8
                };
            let second = if color == 0 { front << 8 } else { front >> 8 };
            sink.add(
                PAWN_SHIELD,
                sign * ((front | second) & ours[0]).count_ones() as i32,
            );
            for file in (king % 8).saturating_sub(1)..=(king % 8 + 1).min(7) {
                let mask = FILE_A << file;
                if ours[0] & mask == 0 {
                    let index = if theirs[0] & mask == 0 {
                        KING_FILE_OPEN
                    } else {
                        KING_FILE_SEMI
                    };
                    sink.add(index, sign);
                }
            }
        }

        // Pawns. A passed pawn has no enemy pawn ahead on its or adjacent files.
        let passed = passed_pawns(setup, color);
        let connected = connected_pawns(setup, color);
        let mut remaining = passed;
        while remaining != 0 {
            let sq = remaining.trailing_zeros() as usize;
            remaining &= remaining - 1;
            let rank = (sq ^ (color * 56)) / 8;
            sink.add(PASSED_PAWN + rank, sign);
            let stop = if color == 0 {
                (sq + 8).min(63)
            } else {
                sq.saturating_sub(8)
            };
            if king < 64 {
                sink.add(PASSED_KING_OWN + rank, sign * chebyshev(stop, king));
            }
            if enemy_king < 64 {
                sink.add(PASSED_KING_ENEMY + rank, sign * chebyshev(stop, enemy_king));
            }
            if connected >> sq & 1 != 0 {
                sink.add(PASSED_CONNECTED + rank, sign);
            }
        }
        let mut remaining = connected & !passed;
        while remaining != 0 {
            let sq = remaining.trailing_zeros() as usize;
            remaining &= remaining - 1;
            sink.add(PAWN_CONNECTED + (sq ^ (color * 56)) / 8, sign);
        }
        // Doubled pawns are the pawns beyond one per occupied file; isolated
        // pawns sit on files whose neighbours hold none of ours.
        let files = (north_fill(ours[0]) & RANK_8).count_ones();
        sink.add(DOUBLED_PAWN, sign * (ours[0].count_ones() - files) as i32);
        let file_bits = ((north_fill(ours[0]) & RANK_8) >> 56) as u8;
        let isolated = file_bits & !((file_bits << 1) | (file_bits >> 1));
        sink.add(
            ISOLATED_PAWN,
            sign * (ours[0] & (FILE_A * u64::from(isolated))).count_ones() as i32,
        );

        // Backward pawns: a neighbour exists but none stands level or behind,
        // and an enemy pawn guards the stop square.
        let enemy_pawn_attacks = pawn_attacks(theirs[0], enemy);
        let mut remaining = ours[0];
        while remaining != 0 {
            let sq = remaining.trailing_zeros() as usize;
            remaining &= remaining - 1;
            let file = FILE_A << (sq % 8);
            let adjacent = ((file & !FILE_H) << 1) | ((file & !FILE_A) >> 1);
            let level_or_behind = if color == 0 {
                u64::MAX >> (56 - (sq / 8) * 8)
            } else {
                u64::MAX << ((sq / 8) * 8)
            };
            let stop = if color == 0 {
                (sq + 8).min(63)
            } else {
                sq.saturating_sub(8)
            };
            if ours[0] & adjacent != 0
                && ours[0] & adjacent & level_or_behind == 0
                && enemy_pawn_attacks >> stop & 1 != 0
            {
                sink.add(PAWN_BACKWARD + usize::from(theirs[0] & file == 0), sign);
            }
        }

        // Pawn shelter and storm on the king's file and its neighbours.
        if king < 64 {
            let king_file = king % 8;
            let king_rank = (king ^ (color * 56)) / 8;
            let nearest = |pawns: u64| {
                let mut best = 7;
                let mut bits = pawns;
                while bits != 0 {
                    let rank = ((bits.trailing_zeros() as usize) ^ (color * 56)) / 8;
                    bits &= bits - 1;
                    if rank > king_rank {
                        best = best.min(rank - king_rank);
                    }
                }
                best
            };
            for file in king_file.saturating_sub(1)..=(king_file + 1).min(7) {
                let mask = FILE_A << file;
                let own = nearest(ours[0] & mask);
                let storm = nearest(theirs[0] & mask);
                sink.add(
                    KING_SHELTER + usize::from(file == king_file) * 8 + own,
                    sign,
                );
                let blocked = own != 7 && own + 1 == storm;
                sink.add(KING_STORM + usize::from(blocked) * 8 + storm, sign);
            }
        }
    }
}

fn features(position: &Position, sink: &mut impl Accumulator) -> i32 {
    let setup = setup(position);
    pawn_king_features(&setup, sink);
    piece_features(position, &setup, sink)
}

/// Every term [`pawn_king_features`] leaves out; returns the game phase.
fn piece_features(position: &Position, setup: &Setup, sink: &mut impl Accumulator) -> i32 {
    let Setup {
        pieces,
        occupied,
        all,
        kings,
    } = *setup;
    let mut attacks = [[0u64; 6]; 2];
    let mut phase = 0;
    for color in 0..2 {
        let sign = if color == 0 { 1 } else { -1 };
        let ours = pieces[color];
        let theirs = pieces[color ^ 1];
        let enemy_pawn_attacks = pawn_attacks(theirs[0], color ^ 1);
        let king_zone = king_zone(setup, color ^ 1);
        let free = !occupied[color] & !enemy_pawn_attacks;
        let mut attackers = [0i32; 5];
        sink.add(BISHOP_PAIR, sign * i32::from(ours[2].count_ones() >= 2));
        // Pawn attacks are counted per capture direction, which equals
        // the sum of the per-pawn attack sets.
        let (left, right) = pawn_captures(ours[0], color);
        attacks[color][0] = left | right;
        sink.add(
            MOBILITY,
            sign * ((left & free).count_ones() + (right & free).count_ones()) as i32,
        );
        for kind in 1..6 {
            let count = ours[kind].count_ones() as i32;
            phase += PHASE[kind] * count;
            sink.add(MATERIAL + kind, sign * count);
            let (mut mobility, mut zone) = (0, 0);
            let mut remaining = ours[kind];
            while remaining != 0 {
                let sq = remaining.trailing_zeros() as usize;
                remaining &= remaining - 1;
                let relative_sq = sq ^ (color * 56);
                sink.add(PST + kind * 64 + relative_sq, sign);
                let targets = match kind {
                    1 => KNIGHT_ATTACKS[sq],
                    2 => bishop_attacks(sq, all),
                    3 => rook_attacks(sq, all),
                    4 => bishop_attacks(sq, all) | rook_attacks(sq, all),
                    _ => KING_ATTACKS[sq],
                };
                attacks[color][kind] |= targets;
                let squares = (targets & free).count_ones();
                let pressure = (targets & king_zone).count_ones();
                mobility += squares;
                zone += pressure;
                if kind < 5 {
                    sink.add(MOBILITY_TABLE[kind] + squares as usize, sign);
                    attackers[kind] += i32::from(pressure > 0);
                }
                if kind == 3 {
                    let file = FILE_A << (sq % 8);
                    if ours[0] & file == 0 {
                        let index = if theirs[0] & file == 0 {
                            ROOK_OPEN
                        } else {
                            ROOK_SEMI_OPEN
                        };
                        sink.add(index, sign);
                    }
                }
            }
            sink.add(MOBILITY + kind, sign * mobility as i32);
            if kind < 5 {
                sink.add(KING_ATTACK + kind, sign * zone as i32);
            }
        }
        for (kind, &count) in attackers.iter().enumerate().skip(1) {
            sink.add(KING_ATTACKERS + kind - 1, sign * count);
        }
        let total: i32 = attackers.iter().sum();
        if total > 0 {
            sink.add(KING_ATTACKER_COUNT + total.min(4) as usize - 1, sign);
        }
    }
    for color in 0..2 {
        let sign = if color == 0 { 1 } else { -1 };
        let enemy = color ^ 1;
        let ours = pieces[color];
        let theirs = pieces[enemy];
        let own_attacks = attacks[color];
        let enemy_attacks = attacks[enemy];
        let own_all = own_attacks.iter().fold(0, |sum, &bits| sum | bits);
        let enemy_all = enemy_attacks.iter().fold(0, |sum, &bits| sum | bits);

        // Threats.
        let unguarded = !enemy_attacks[0];
        let minors = own_attacks[1] | own_attacks[2];
        for (kind, &bits) in theirs.iter().enumerate().take(5).skip(1) {
            sink.add(
                THREAT_PAWN + kind - 1,
                sign * (own_attacks[0] & bits).count_ones() as i32,
            );
        }
        for (kind, &bits) in theirs.iter().enumerate().take(5) {
            let target = bits & unguarded;
            sink.add(
                THREAT_MINOR + kind,
                sign * (minors & target).count_ones() as i32,
            );
            sink.add(
                THREAT_ROOK + kind,
                sign * (own_attacks[3] & target).count_ones() as i32,
            );
        }
        let enemy_pieces = theirs[1] | theirs[2] | theirs[3] | theirs[4];
        sink.add(
            HANGING,
            sign * (enemy_pieces & own_all & !enemy_all).count_ones() as i32,
        );
        let pushes = if color == 0 {
            (ours[0] << 8) & !all
        } else {
            (ours[0] >> 8) & !all
        };
        let safe_pushes = pushes & unguarded & (own_all | !enemy_all);
        sink.add(
            PUSH_THREAT,
            sign * (pawn_attacks(safe_pushes, color) & enemy_pieces).count_ones() as i32,
        );

        // King safety.
        let enemy_king = kings[enemy];
        if enemy_king < 64 {
            let bishop_checks = bishop_attacks(enemy_king, all);
            let rook_checks = rook_attacks(enemy_king, all);
            let checks = [
                KNIGHT_ATTACKS[enemy_king],
                bishop_checks,
                rook_checks,
                bishop_checks | rook_checks,
            ];
            let safe = !occupied[color] & !enemy_all;
            for (kind, &squares) in checks.iter().enumerate() {
                if own_attacks[kind + 1] & squares & safe != 0 {
                    sink.add(SAFE_CHECK + kind, sign);
                }
            }
        }

        // Passed pawns whose stop square is empty or not attacked.
        let mut remaining = passed_pawns(setup, color);
        while remaining != 0 {
            let sq = remaining.trailing_zeros() as usize;
            remaining &= remaining - 1;
            let rank = (sq ^ (color * 56)) / 8;
            let stop = if color == 0 {
                (sq + 8).min(63)
            } else {
                sq.saturating_sub(8)
            };
            let stop_bit = 1u64 << stop;
            if stop_bit & all == 0 {
                sink.add(PASSED_FREE + rank, sign);
            }
            if stop_bit & enemy_all == 0 {
                sink.add(PASSED_SAFE + rank, sign);
            }
        }

        // Outposts: pawn-guarded squares no enemy pawn can ever attack.
        let span = if color == 0 {
            south_fill(enemy_attacks[0])
        } else {
            north_fill(enemy_attacks[0])
        };
        let outposts = OUTPOST_RANKS[color] & own_attacks[0] & !span;
        sink.add(
            KNIGHT_OUTPOST,
            sign * (ours[1] & outposts).count_ones() as i32,
        );
        sink.add(
            BISHOP_OUTPOST,
            sign * (ours[2] & outposts).count_ones() as i32,
        );

        // Rook on the seventh.
        let (seventh, eighth) = if color == 0 {
            (0xFF << 48, RANK_8)
        } else {
            (0xFF << 8, 0xFF)
        };
        if (theirs[5] & eighth) | (theirs[0] & seventh) != 0 {
            sink.add(ROOK_SEVENTH, sign * (ours[3] & seventh).count_ones() as i32);
        }

        // Minor pieces behind a pawn, bishops hemmed by rammed pawns, long diagonals.
        let pawns = ours[0] | theirs[0];
        let (in_front, rammed) = if color == 0 {
            (pawns >> 8, ours[0] & (theirs[0] >> 8))
        } else {
            (pawns << 8, ours[0] & (theirs[0] << 8))
        };
        sink.add(
            MINOR_BEHIND_PAWN,
            sign * (ours[1] & in_front).count_ones() as i32,
        );
        sink.add(
            MINOR_BEHIND_PAWN + 1,
            sign * (ours[2] & in_front).count_ones() as i32,
        );
        let mut bishops = ours[2];
        while bishops != 0 {
            let sq = bishops.trailing_zeros() as usize;
            bishops &= bishops - 1;
            let colour = if DARK_SQUARES >> sq & 1 != 0 {
                DARK_SQUARES
            } else {
                !DARK_SQUARES
            };
            sink.add(BISHOP_RAMMED, sign * (rammed & colour).count_ones() as i32);
            if LONG_DIAGONALS >> sq & 1 != 0
                && CENTER & (1 << sq) == 0
                && (bishop_attacks(sq, pawns) & CENTER).count_ones() >= 2
            {
                sink.add(BISHOP_LONG_DIAGONAL, sign);
            }
        }
    }
    sink.add(
        TEMPO,
        if position.side_to_move() == Color::White {
            1
        } else {
            -1
        },
    );
    phase.min(MAX_PHASE)
}
