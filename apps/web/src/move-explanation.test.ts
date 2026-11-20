import type { SideExploreExplanationDto } from "./engine-dtos";
import { explainRecommendation } from "./move-explanation";

function expectEqual<T>(actual: T, expected: T): void {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText !== expectedText) {
    throw new Error(`expected ${expectedText}, got ${actualText}`);
  }
}

const quiet: SideExploreExplanationDto = {
  inCheck: false,
  threatened: [],
  best: {
    move: "e2e4",
    piece: "pawn",
    captured: null,
    promotion: null,
    castle: null,
    check: false,
    mate: false,
    threats: [],
    savesThreatened: false,
    hangs: false
  },
  lineMaterialCp: 0
};
const plain = { exactScoreCp: 20, mateIn: null, sacrifice: false };

expectEqual(explainRecommendation(quiet, plain, "es"), "Juega e2→e4: mejora tu posición.");
expectEqual(explainRecommendation(quiet, plain, "en"), "Play e2→e4: improves your position.");

const richBest = {
  ...quiet.best,
  move: "f3e5",
  piece: "knight" as const,
  captured: "pawn" as const,
  threats: [{ square: "a8", piece: "rook" as const }],
  check: true
};
const rich: SideExploreExplanationDto = {
  ...quiet,
  threatened: [{ square: "d8", piece: "queen" }],
  best: richBest,
  lineMaterialCp: 100
};
const winning = { exactScoreCp: 150, mateIn: null, sacrifice: false };

// Priority: capture, then check (two facts max); threats are cut.
expectEqual(
  explainRecommendation(rich, winning, "es"),
  "El rival amenaza tu dama en d8. Juega f3→e5: captura el peón de e5 y da jaque. La línea gana un peón."
);
expectEqual(
  explainRecommendation(rich, winning, "en"),
  "Your opponent threatens your queen on d8. Play f3→e5: captures the pawn on e5 and gives check. The line wins a pawn."
);

// The outcome needs both a material gain and a clearly positive score.
expectEqual(
  explainRecommendation(rich, { ...winning, exactScoreCp: 79 }, "es").includes("La línea"),
  false
);
expectEqual(
  explainRecommendation({ ...rich, lineMaterialCp: 99 }, winning, "es").includes("La línea"),
  false
);
expectEqual(
  explainRecommendation({ ...rich, lineMaterialCp: 330 }, winning, "es").endsWith(
    "La línea gana una pieza."
  ),
  true
);
expectEqual(
  explainRecommendation({ ...rich, lineMaterialCp: 200 }, winning, "es").endsWith(
    "La línea gana la calidad."
  ),
  true
);
expectEqual(
  explainRecommendation({ ...rich, lineMaterialCp: 900 }, winning, "en").endsWith(
    "The line wins the queen."
  ),
  true
);

// In check, saving a piece, a new threat and mate in N.
const savesBest = {
  ...quiet.best,
  move: "d1a4",
  piece: "queen" as const,
  savesThreatened: true,
  threats: [{ square: "a8", piece: "rook" as const }]
};
expectEqual(
  explainRecommendation(
    {
      ...quiet,
      inCheck: true,
      threatened: [{ square: "d1", piece: "queen" }],
      best: savesBest
    },
    plain,
    "es"
  ),
  "Estás en jaque. Juega d1→a4: pone a salvo tu dama y ataca la torre de a8."
);
expectEqual(
  explainRecommendation(
    { ...quiet, best: { ...quiet.best, check: true } },
    { exactScoreCp: 30000, mateIn: 3, sacrifice: true },
    "es"
  ),
  "Juega e2→e4: fuerza mate en 3 jugadas y da jaque."
);
expectEqual(
  explainRecommendation(
    { ...quiet, best: { ...quiet.best, check: true, mate: true } },
    { exactScoreCp: 30000, mateIn: 1, sacrifice: false },
    "en"
  ),
  "Play e2→e4: delivers checkmate."
);

// Lower-priority facts: castle, promotion, sacrifice, leaving check.
expectEqual(
  explainRecommendation(
    { ...quiet, best: { ...quiet.best, move: "e1g1", piece: "king", castle: "king" } },
    plain,
    "es"
  ),
  "Juega e1→g1: enroca y protege al rey."
);
expectEqual(
  explainRecommendation(
    { ...quiet, best: { ...quiet.best, move: "a7a8q", promotion: "queen" } },
    plain,
    "en"
  ),
  "Play a7→a8: promotes the pawn to a queen."
);
expectEqual(
  explainRecommendation(quiet, { ...plain, sacrifice: true }, "es"),
  "Juega e2→e4: sacrifica la pieza a cambio de iniciativa."
);
expectEqual(
  explainRecommendation({ ...quiet, inCheck: true }, plain, "es"),
  "Estás en jaque. Juega e2→e4: te saca del jaque."
);

// A pawn taking a pawn onto the en passant rank does not name a square that might be wrong.
expectEqual(
  explainRecommendation(
    { ...quiet, best: { ...quiet.best, move: "e5d6", captured: "pawn" } },
    plain,
    "es"
  ),
  "Juega e5→d6: captura un peón."
);
