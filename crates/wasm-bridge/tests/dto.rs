use chess_wasm_bridge::{
    AnalyzeRequestDto, BestMoveRequestDto, ColorDto, DrawReasonDto, ForcingKindDto, GameStatusDto,
    MakeMoveContextRequestDto, MakeMoveRequestDto, MoveLabelDto, MoveQualityDto,
    ReviewPgnRequestDto, SideExploreContextV2RequestDto, SideExploreRequestDto, WasmBridgeError,
    analyze, best_move, make_move, new_game, review_pgn, review_pgn_with_artifacts,
    side_explore_call, side_explore_context_json, side_explore_context_v2_call,
};

const STARTPOS: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

#[test]
fn new_game_returns_canonical_start_state() {
    let state = new_game();

    assert_eq!(state.fen, STARTPOS);
    assert_eq!(state.status, GameStatusDto::Ongoing);
    assert_eq!(state.side_to_move, ColorDto::White);
    assert_eq!(state.legal_moves.len(), 20);
    assert_eq!(state.legal_moves[0], "a2a3");
}

#[test]
fn make_move_applies_legal_coordinate_move_and_returns_san() {
    let result = make_move(MakeMoveRequestDto {
        fen: STARTPOS.to_owned(),
        mv: "e2e4".to_owned(),
    })
    .unwrap();

    assert_eq!(result.applied_move, "e2e4");
    assert_eq!(result.san, "e4");
    assert_eq!(
        result.state.fen,
        "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
    );
    assert_eq!(result.state.side_to_move, ColorDto::Black);
    assert_eq!(result.state.status, GameStatusDto::Ongoing);
    assert_eq!(result.state.legal_moves.len(), 20);
}

#[test]
fn bridge_exposes_automatic_draw_reasons() {
    let insufficient = chess_wasm_bridge::position_json("7k/8/8/8/8/8/8/K7 w - - 0 1");
    assert!(
        insufficient.contains(r#""status":"draw""#),
        "{insufficient}"
    );
    assert!(
        insufficient.contains(r#""drawReason":"insufficient-material""#),
        "{insufficient}"
    );

    let fifty_move = chess_wasm_bridge::position_json("7k/8/8/8/8/8/8/R6K w - - 100 1");
    assert!(fifty_move.contains(r#""status":"draw""#), "{fifty_move}");
    assert!(
        fifty_move.contains(r#""drawReason":"fifty-move""#),
        "{fifty_move}"
    );

    let checkmate = chess_wasm_bridge::position_json("7k/6Q1/6K1/8/8/8/8/8 b - - 100 1");
    assert!(checkmate.contains(r#""status":"checkmate""#), "{checkmate}");
    assert!(checkmate.contains(r#""drawReason":null"#), "{checkmate}");
}

#[test]
fn bridge_detects_threefold_repetition_from_real_history() {
    let moves = [
        "b1c3", "b8c6", "c3b1", "c6b8", "b1c3", "b8c6", "c3b1", "c6b8", "b1c3", "b8c6", "c3b1",
        "c6b8",
    ];
    let mut current_fen = STARTPOS.to_owned();
    let mut history_fens = Vec::new();
    let mut result = None;

    for mv in moves {
        history_fens.push(current_fen.clone());
        let next = chess_wasm_bridge::make_move_with_history(MakeMoveContextRequestDto {
            fen: current_fen,
            mv: mv.to_owned(),
            history_fens: history_fens.join("\n"),
        })
        .unwrap();
        current_fen = next.state.fen.clone();
        result = Some(next);
    }

    let final_result = result.expect("repetition sequence has moves");
    assert_eq!(final_result.state.status, GameStatusDto::Draw);
    assert_eq!(
        final_result.state.draw_reason,
        Some(DrawReasonDto::ThreefoldRepetition)
    );
}

#[test]
fn bridge_returns_stable_errors_for_bad_inputs() {
    assert_eq!(
        make_move(MakeMoveRequestDto {
            fen: "not-a-fen".to_owned(),
            mv: "e2e4".to_owned(),
        })
        .unwrap_err(),
        WasmBridgeError::InvalidFen
    );
    assert_eq!(
        make_move(MakeMoveRequestDto {
            fen: STARTPOS.to_owned(),
            mv: "bad".to_owned(),
        })
        .unwrap_err(),
        WasmBridgeError::InvalidMove
    );
    assert_eq!(
        make_move(MakeMoveRequestDto {
            fen: STARTPOS.to_owned(),
            mv: "e2e5".to_owned(),
        })
        .unwrap_err(),
        WasmBridgeError::InvalidMove
    );
    assert_eq!(
        best_move(BestMoveRequestDto {
            fen: STARTPOS.to_owned(),
            depth: 0,
            aggressive: false,
            node_budget: 0,
        })
        .unwrap_err(),
        WasmBridgeError::InvalidDepth
    );
}

#[test]
fn best_move_and_analyze_are_deterministic() {
    let request = BestMoveRequestDto {
        fen: STARTPOS.to_owned(),
        depth: 1,
        aggressive: false,
        node_budget: 5_000,
    };
    let best = best_move(request.clone()).unwrap();
    assert_eq!(best, best_move(request).unwrap());

    let chosen = best.best_move.clone().expect("a move must be chosen");
    assert!(new_game().legal_moves.contains(&chosen));
    assert!(best.depth >= 1);
    assert!(best.nodes > 0);

    let analysis = analyze(AnalyzeRequestDto {
        fen: STARTPOS.to_owned(),
        depth: 1,
    })
    .unwrap();

    assert_eq!(analysis.state.fen, STARTPOS);
    let analysed = analysis.best_move.expect("analysis must pick a move");
    assert!(analysis.state.legal_moves.contains(&analysed));
    assert!(analysis.depth >= 1);
    assert!(analysis.nodes > 0);
}

#[test]
fn aggressive_best_move_is_deterministic_and_legal() {
    let request = BestMoveRequestDto {
        fen: STARTPOS.to_owned(),
        depth: 4,
        aggressive: true,
        node_budget: 0,
    };

    let first = best_move(request.clone()).unwrap();
    let second = best_move(request).unwrap();

    assert_eq!(first, second, "aggressive search must be deterministic");
    let chosen = first.best_move.expect("a move must be chosen");
    let state = new_game();
    assert!(
        state.legal_moves.contains(&chosen),
        "the aggressive move must be legal from the start position"
    );
}

#[test]
fn semantic_invalid_positions_return_invalid_position() {
    let stale_castling = "4k3/8/8/8/8/8/8/4K3 w Kq - 0 1";

    assert_eq!(
        best_move(BestMoveRequestDto {
            fen: stale_castling.to_owned(),
            depth: 1,
            aggressive: false,
            node_budget: 0,
        })
        .unwrap_err(),
        WasmBridgeError::InvalidPosition
    );
    assert_eq!(
        analyze(AnalyzeRequestDto {
            fen: stale_castling.to_owned(),
            depth: 1,
        })
        .unwrap_err(),
        WasmBridgeError::InvalidPosition
    );
    assert_eq!(
        make_move(MakeMoveRequestDto {
            fen: stale_castling.to_owned(),
            mv: "e1d1".to_owned(),
        })
        .unwrap_err(),
        WasmBridgeError::InvalidPosition
    );
}

#[test]
fn review_pgn_returns_deterministic_core_review_dtos() {
    let request = ReviewPgnRequestDto {
        pgn: "1. a3 *".to_owned(),
        depth: 3,
    };

    let first = review_pgn(request.clone()).unwrap();
    let second = review_pgn(request).unwrap();

    assert_eq!(first, second);
    assert_eq!(first.summary.total_moves, 1);
    assert_eq!(first.summary.best, 0);
    assert_eq!(first.summary.good, 1);
    assert_eq!(first.entries.len(), 1);

    let entry = &first.entries[0];
    assert_eq!(entry.ply, 1);
    assert_eq!(entry.played_move, "a2a3");
    assert_eq!(entry.san, "a3");
    assert_eq!(entry.best_move.as_deref(), Some("b1c3"));
    assert_eq!(entry.best_score_cp, 24);
    assert_eq!(entry.played_score_cp, -6);
    assert_eq!(entry.cp_loss, 30);
    assert_eq!(entry.label, MoveLabelDto::Good);
}

#[test]
fn review_pgn_accepts_parser_valid_empty_game() {
    let review = review_pgn(ReviewPgnRequestDto {
        pgn: "*".to_owned(),
        depth: 2,
    })
    .unwrap();

    assert!(review.entries.is_empty());
    assert_eq!(review.summary.total_moves, 0);
    assert_eq!(review.summary.best, 0);
    assert_eq!(review.summary.good, 0);
    assert_eq!(review.summary.inaccuracies, 0);
    assert_eq!(review.summary.mistakes, 0);
    assert_eq!(review.summary.blunders, 0);
}

#[test]
fn review_pgn_rejects_wrong_reasons_with_stable_errors() {
    for pgn in ["", "1. e5 *", "1. e4 {comment} *"] {
        assert_eq!(
            review_pgn(ReviewPgnRequestDto {
                pgn: pgn.to_owned(),
                depth: 2,
            })
            .unwrap_err(),
            WasmBridgeError::InvalidPgn,
            "{pgn:?}"
        );
    }

    for depth in [0, 1, 7] {
        assert_eq!(
            review_pgn(ReviewPgnRequestDto {
                pgn: "1. a3 *".to_owned(),
                depth,
            })
            .unwrap_err(),
            WasmBridgeError::InvalidDepth,
            "{depth}"
        );
    }
}

#[test]
fn review_pgn_with_artifacts_returns_existing_coach_artifacts_without_changing_core_review() {
    let request = ReviewPgnRequestDto {
        pgn: "1. f3 e5 2. g4 Qh4# 0-1".to_owned(),
        depth: 3,
    };

    let core = review_pgn(request.clone()).unwrap();
    let with_artifacts = review_pgn_with_artifacts(request).unwrap();

    assert_eq!(with_artifacts.review, core);
    assert_eq!(with_artifacts.artifacts.key_moments.len(), 1);
    assert_eq!(with_artifacts.artifacts.evidence.len(), 1);
    assert_eq!(with_artifacts.artifacts.fork_candidates.len(), 0);
    assert_eq!(with_artifacts.artifacts.early_move_divergences.len(), 1);
    assert_eq!(with_artifacts.artifacts.retry_positions.len(), 1);

    let key_moment = &with_artifacts.artifacts.key_moments[0];
    assert_eq!(key_moment.rank, 1);
    assert_eq!(key_moment.entry_index, 2);
    assert_eq!(key_moment.kind, "centipawn-loss");
    assert_eq!(key_moment.ply, 3);
    assert_eq!(key_moment.played_move, "g2g4");
    assert_eq!(key_moment.san, "g4");
    assert_eq!(key_moment.best_move.as_deref(), Some("b1c3"));
    assert_eq!(key_moment.label, MoveLabelDto::Blunder);

    let evidence = &with_artifacts.artifacts.evidence[0];
    assert_eq!(evidence.kind, "local-search-swing");
    assert_eq!(evidence.entry_index, key_moment.entry_index);
    assert_eq!(evidence.cp_loss, key_moment.cp_loss);

    let divergence = &with_artifacts.artifacts.early_move_divergences[0];
    assert_eq!(divergence.entry_index, key_moment.entry_index);
    assert_eq!(divergence.local_best_move, "b1c3");

    let retry = &with_artifacts.artifacts.retry_positions[0];
    assert_eq!(retry.entry_index, key_moment.entry_index);
    assert_eq!(
        retry.fen_before,
        "rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2"
    );
}

#[test]
fn review_pgn_with_artifacts_filters_pawn_only_fork_candidates() {
    let with_artifacts = review_pgn_with_artifacts(ReviewPgnRequestDto {
        pgn: "1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Nb5 a6 5. Na3 *".to_owned(),
        depth: 2,
    })
    .unwrap();

    assert_eq!(with_artifacts.artifacts.fork_candidates, []);
}

#[test]
fn review_pgn_with_artifacts_exposes_fork_candidates_from_coach_evidence() {
    let review = review_pgn_with_artifacts(ReviewPgnRequestDto {
        pgn: "1. e4 e5 2. Qh5 Nc6 3. Bc4 Bc5 4. a3 *".to_owned(),
        depth: 2,
    })
    .unwrap();

    assert_eq!(review.artifacts.fork_candidates.len(), 1);
    let candidate = &review.artifacts.fork_candidates[0];
    assert_eq!(candidate.rank, 1);
    assert_eq!(candidate.entry_index, 6);
    assert_eq!(candidate.ply, 7);
    assert_eq!(candidate.source_kind, "best-move-after-position");
    assert_eq!(candidate.best_move, "h5f7");
    assert_eq!(candidate.moved_piece.color, ColorDto::White);
    assert_eq!(candidate.moved_piece.kind, "queen");
    assert_eq!(candidate.destination, "f7");
    assert_eq!(candidate.label, MoveLabelDto::Blunder);
    assert!(
        candidate
            .targets
            .iter()
            .any(|target| target.square == "e8" && target.piece.kind == "king")
    );
    assert!(
        candidate
            .targets
            .iter()
            .any(|target| target.square == "g7" && target.piece.kind == "pawn")
    );
}

#[test]
fn side_explore_on_turn_returns_candidates_with_exact_scores() {
    let result = side_explore_call(SideExploreRequestDto {
        fen: STARTPOS.to_owned(),
        side: ColorDto::White,
        aggressive: true,
    })
    .expect("side_explore must succeed");

    assert!(result.on_turn, "White to move in startpos");
    assert_eq!(result.side, ColorDto::White);
    assert!(!result.candidates.is_empty(), "must yield candidates");
    assert!(
        !result.principal_line.is_empty(),
        "must yield a principal line"
    );
    assert!(result.depth >= 1, "must reach at least depth 1");
    assert_eq!(result.sound_margin_cp, 50, "must carry the sound margin");

    // The top candidate must always be sound (it cannot fall below itself).
    let top = result.candidates.first().expect("non-empty");
    assert!(top.sound, "top candidate must always be sound: {top:?}");

    for c in &result.candidates {
        // Startpos has no forced mate and no sacrifice.
        assert!(
            !matches!(c.kind, ForcingKindDto::Mate),
            "startpos has no forced mate: {c:?}"
        );
        assert!(
            !c.sacrifice,
            "no startpos move should be a sacrifice: {c:?}"
        );
    }
}

#[test]
fn side_explore_rejects_a_false_brilliant_when_objective_anchor_finds_mate() {
    let result = side_explore_call(SideExploreRequestDto {
        fen: "rn4k1/6pp/5n2/7Q/8/8/2B5/5RK1 w - - 0 1".to_owned(),
        side: ColorDto::White,
        aggressive: true,
    })
    .expect("side_explore must succeed");

    assert_eq!(
        result
            .candidates
            .first()
            .expect("objective anchor candidate")
            .kind,
        ForcingKindDto::Mate
    );
    assert!(
        result
            .candidates
            .iter()
            .all(|candidate| !candidate.prospective_brilliant),
        "a position with an objective forced mate must not fabricate a Brilliant candidate: {:?}",
        result.candidates
    );
}

#[test]
fn aggressive_side_explore_keeps_owner_endgame_anchor_at_product_budget() {
    let fen = "8/1P3pk1/4p3/4P3/3P1PP1/8/3Q3K/6R1 b - - 0 46";
    let neutral = side_explore_call(SideExploreRequestDto {
        fen: fen.to_owned(),
        side: ColorDto::Black,
        aggressive: false,
    })
    .expect("neutral owner-FEN Explore must succeed");
    let aggressive = side_explore_call(SideExploreRequestDto {
        fen: fen.to_owned(),
        side: ColorDto::Black,
        aggressive: true,
    })
    .expect("aggressive owner-FEN Explore must succeed");

    // Stockfish depth 22 mates Black in 5 after every legal move here, so which losing move is
    // listed first, and its per-move tags, carry no chess meaning. Keep the DTO contract only.
    assert!(!neutral.candidates.is_empty());
    let aggressive_top = aggressive.candidates.first().expect("aggressive candidate");
    assert!(
        aggressive_top.sound,
        "owner endgame DTO primary must be sound"
    );
}

#[test]
fn adr0221_side_explore_context_json_preserves_old_shape() {
    let output = side_explore_context_json(STARTPOS, "white", true, STARTPOS);

    assert!(
        output.starts_with(r#"{"ok":true,"sideExplore":{"#),
        "old side_explore_context_json envelope must stay backward compatible"
    );
    assert!(
        !output.contains("sideExploreV2"),
        "minimal additive surfaces must not rename or replace the old envelope"
    );
}

#[test]
fn adr0221_side_explore_v2_uses_budget_and_reports_followed_plan() {
    let after_e4 = make_move(MakeMoveRequestDto {
        fen: STARTPOS.to_owned(),
        mv: "e2e4".to_owned(),
    })
    .expect("e2e4 must apply")
    .state;
    let after_c6 = make_move(MakeMoveRequestDto {
        fen: after_e4.fen.clone(),
        mv: "b8c6".to_owned(),
    })
    .expect("b8c6 must apply")
    .state;
    let history = format!("{}\n{}", STARTPOS, after_e4.fen);
    let baseline = side_explore_context_v2_call(SideExploreContextV2RequestDto {
        fen: after_c6.fen.clone(),
        side: ColorDto::White,
        aggressive: true,
        history_fens: history.clone(),
        node_budget: 2_000,
        previous_line: String::new(),
    })
    .expect("baseline v2 side_explore must run");
    let continuation = baseline
        .candidates
        .first()
        .expect("baseline must have a candidate")
        .mv
        .clone();
    let previous_line = format!("e2e4,b8c6,{continuation}");
    let fast = side_explore_context_v2_call(SideExploreContextV2RequestDto {
        fen: after_c6.fen.clone(),
        side: ColorDto::White,
        aggressive: true,
        history_fens: history.clone(),
        node_budget: 2_000,
        previous_line: previous_line.clone(),
    })
    .expect("fast v2 side_explore must run");
    let deep = side_explore_context_v2_call(SideExploreContextV2RequestDto {
        fen: after_c6.fen,
        side: ColorDto::White,
        aggressive: true,
        history_fens: history,
        node_budget: 60_000,
        previous_line,
    })
    .expect("deep v2 side_explore must run");

    assert_eq!(fast.plan_status, Some("followed"));
    assert_eq!(fast.plan_reason, Some("matched-history-and-gate"));
    assert!(
        fast.nodes < deep.nodes,
        "v2 Fast budget must reach search with fewer nodes: fast={} deep={}",
        fast.nodes,
        deep.nodes
    );
}

#[test]
fn aggressive_side_explore_keeps_off_turn_reply_candidates_neutral() {
    let neutral = side_explore_call(SideExploreRequestDto {
        fen: STARTPOS.to_owned(),
        side: ColorDto::Black,
        aggressive: false,
    })
    .expect("neutral off-turn side_explore must succeed");
    let aggressive = side_explore_call(SideExploreRequestDto {
        fen: STARTPOS.to_owned(),
        side: ColorDto::Black,
        aggressive: true,
    })
    .expect("aggressive off-turn side_explore must succeed");

    assert!(!neutral.on_turn);
    assert!(!aggressive.on_turn);
    assert_eq!(aggressive.reply_candidates, neutral.reply_candidates);
}

#[test]
fn side_explore_off_turn_returns_classified_selected_side_plan() {
    let result = side_explore_call(SideExploreRequestDto {
        fen: STARTPOS.to_owned(),
        side: ColorDto::Black,
        aggressive: false,
    })
    .expect("side_explore must succeed");

    assert!(!result.on_turn, "White to move means off-turn for Black");
    assert_eq!(result.side, ColorDto::Black);
    assert!(
        !result.reply_candidates.is_empty(),
        "must expose the opponent's plausible classified replies"
    );
    let projected_reply = result.reply_candidates[0].mv.as_str();
    assert!(result.reply_candidates.len() <= 4);
    for reply in &result.reply_candidates {
        assert!(!reply.mv.is_empty());
        assert!(matches!(
            reply.kind,
            ForcingKindDto::Mate
                | ForcingKindDto::Check
                | ForcingKindDto::Capture
                | ForcingKindDto::Defense
        ));
        assert!(matches!(
            reply.quality,
            MoveQualityDto::Brilliant
                | MoveQualityDto::Great
                | MoveQualityDto::Best
                | MoveQualityDto::Excellent
                | MoveQualityDto::Good
                | MoveQualityDto::Inaccuracy
                | MoveQualityDto::Mistake
                | MoveQualityDto::Blunder
        ));
    }
    assert!(
        !result.candidates.is_empty(),
        "must surface selected side plan"
    );
    assert!(
        result
            .candidates
            .iter()
            .all(|candidate| candidate.mv != projected_reply),
        "projected reply is separate from selected-side candidates"
    );
}

#[test]
fn side_explore_off_turn_reply_candidates_preserve_mate_classification() {
    let result = side_explore_call(SideExploreRequestDto {
        fen: "7k/8/5K2/8/8/8/8/6Q1 w - - 0 1".to_owned(),
        side: ColorDto::Black,
        aggressive: false,
    })
    .expect("side_explore must succeed");

    let top = result
        .reply_candidates
        .first()
        .expect("rival mate reply must be present");
    assert_eq!(top.mv, "g1g7");
    assert_eq!(top.role, "objective-primary");
    assert_eq!(top.kind, ForcingKindDto::Mate);
    assert_eq!(top.quality, MoveQualityDto::Best);
    assert_eq!(top.mate_in, Some(1));
}

#[test]
fn side_explore_backward_compat_neutral_reaction_map_unchanged() {
    use chess_wasm_bridge::{ReactionMapRequestDto, reaction_map};
    let first = reaction_map(ReactionMapRequestDto {
        fen: STARTPOS.to_owned(),
        depth: 3,
        deep: true,
    })
    .expect("reaction_map must succeed");
    let second = reaction_map(ReactionMapRequestDto {
        fen: STARTPOS.to_owned(),
        depth: 3,
        deep: true,
    })
    .expect("reaction_map must succeed");

    assert_eq!(
        first
            .root_candidates
            .iter()
            .map(|c| &c.mv)
            .collect::<Vec<_>>(),
        second
            .root_candidates
            .iter()
            .map(|c| &c.mv)
            .collect::<Vec<_>>(),
        "neutral reaction_map must be deterministic and unaffected by side_explore"
    );
}
