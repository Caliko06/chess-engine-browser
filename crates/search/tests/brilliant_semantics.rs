use chess_board::{Move, Position};
use chess_eval::MoveQuality;
use chess_search::{SearchConfig, reaction_lines};

const CORPUS: &str = include_str!("../../../tests/oracle/fixtures/brilliant-semantics-v1.tsv");

fn quality_name(quality: MoveQuality) -> &'static str {
    match quality {
        MoveQuality::Brilliant => "brilliant",
        MoveQuality::Great => "great",
        MoveQuality::Best => "best",
        MoveQuality::Excellent => "excellent",
        MoveQuality::Good => "good",
        MoveQuality::Inaccuracy => "inaccuracy",
        MoveQuality::Mistake => "mistake",
        MoveQuality::Blunder => "blunder",
    }
}

#[test]
fn corpus_characterizes_current_public_reaction_labels() {
    let mut classes = std::collections::BTreeSet::new();
    for (index, line) in CORPUS.lines().enumerate().skip(1) {
        let fields: Vec<_> = line.split('\t').collect();
        assert_eq!(fields.len(), 8, "row {} must keep the v1 schema", index + 1);
        let [
            id,
            class,
            fen,
            coordinate,
            expected,
            retrospective,
            evidence,
            verifier,
        ] = fields.as_slice()
        else {
            unreachable!("field count checked")
        };
        classes.insert(*class);
        assert!(
            matches!(*retrospective, "NO" | "UNKNOWN"),
            "{id}: invalid target"
        );
        assert!(
            !evidence.is_empty() && !verifier.is_empty(),
            "{id}: missing audit metadata"
        );

        let position = Position::from_fen(fen).unwrap_or_else(|_| panic!("{id}: FEN must parse"));
        let mv = Move::from_coordinate(coordinate).unwrap_or_else(|_| panic!("{id}: move parses"));
        assert!(
            position
                .legal_moves()
                .expect("legal generation")
                .contains(&mv),
            "{id}: corpus move must be legal"
        );
        let lines = reaction_lines(&position, SearchConfig { max_depth: 2 })
            .unwrap_or_else(|_| panic!("{id}: reaction lines must run"));
        let actual = lines
            .candidates
            .iter()
            .find(|candidate| candidate.mv == mv)
            .unwrap_or_else(|| panic!("{id}: move must remain observable"));
        assert_eq!(
            quality_name(actual.quality),
            *expected,
            "{id}: behavior drift"
        );
    }
    assert_eq!(
        classes.len(),
        9,
        "every required semantic class must be distinct"
    );
}
