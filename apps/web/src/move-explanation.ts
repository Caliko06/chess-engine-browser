import type {
  ExplanationPieceDto,
  SideExploreExplanationDto,
  SideExploreExplanationSquareDto
} from "./engine-dtos.js";

export type ExplainedCandidate = {
  readonly exactScoreCp: number;
  readonly mateIn: number | null;
  readonly sacrifice: boolean;
};

export type ExplanationLocale = "es" | "en";

type PieceWords = { readonly name: string; readonly article: string };

const pieceWords: Record<ExplanationLocale, Record<ExplanationPieceDto, PieceWords>> = {
  es: {
    pawn: { name: "peón", article: "el" },
    knight: { name: "caballo", article: "el" },
    bishop: { name: "alfil", article: "el" },
    rook: { name: "torre", article: "la" },
    queen: { name: "dama", article: "la" },
    king: { name: "rey", article: "el" }
  },
  en: {
    pawn: { name: "pawn", article: "the" },
    knight: { name: "knight", article: "the" },
    bishop: { name: "bishop", article: "the" },
    rook: { name: "rook", article: "the" },
    queen: { name: "queen", article: "the" },
    king: { name: "king", article: "the" }
  }
};

const minLineGainCp = 100;
const minLineScoreCp = 80;
const maxFacts = 2;

/// Builds a short human sentence (threat context, "Juega X: ...", line outcome) from the
/// bridge facts. Pure: no board access, only the DTO and the candidate's score tags.
export function explainRecommendation(
  explanation: SideExploreExplanationDto,
  candidate: ExplainedCandidate,
  locale: ExplanationLocale
): string {
  const parts: string[] = [];
  // A checkmate makes any threat context moot.
  const context = explanation.best.mate ? null : threatContext(explanation, locale);
  if (context !== null) {
    parts.push(context);
  }
  parts.push(moveSentence(explanation, candidate, locale));
  const outcome = lineOutcome(explanation, candidate, locale);
  if (outcome !== null) {
    parts.push(outcome);
  }
  return parts.join(" ");
}

function threatContext(explanation: SideExploreExplanationDto, locale: ExplanationLocale): string | null {
  if (explanation.inCheck) {
    return locale === "es" ? "Estás en jaque." : "You are in check.";
  }
  const threatened = explanation.threatened.slice(0, 2);
  if (threatened.length === 0) {
    return null;
  }
  if (locale === "es") {
    const list = threatened.map((entry) => `tu ${piece(entry.piece, locale)} en ${entry.square}`);
    return `El rival amenaza ${list.join(" y ")}.`;
  }
  const list = threatened.map((entry) => `your ${piece(entry.piece, locale)} on ${entry.square}`);
  return `Your opponent threatens ${list.join(" and ")}.`;
}

function moveSentence(
  explanation: SideExploreExplanationDto,
  candidate: ExplainedCandidate,
  locale: ExplanationLocale
): string {
  const { move } = explanation.best;
  const label = `${move.slice(0, 2)}→${move.slice(2, 4)}`;
  const facts = moveFacts(explanation, candidate, locale).slice(0, maxFacts);
  const fallback = locale === "es" ? "mejora tu posición" : "improves your position";
  const body = (facts.length === 0 ? [fallback] : facts).join(locale === "es" ? " y " : " and ");
  return `${locale === "es" ? "Juega" : "Play"} ${label}: ${body}.`;
}

/// Facts in priority order: mate > capture > saves a piece > check > new threat > castle >
/// promotion > sacrifice > leaves check.
function moveFacts(
  explanation: SideExploreExplanationDto,
  candidate: ExplainedCandidate,
  locale: ExplanationLocale
): string[] {
  const es = locale === "es";
  const { best } = explanation;
  const facts: string[] = [];

  if (candidate.mateIn !== null && candidate.mateIn > 1) {
    facts.push(
      es ? `fuerza mate en ${String(candidate.mateIn)} jugadas` : `forces mate in ${String(candidate.mateIn)}`
    );
  } else if (best.mate || candidate.mateIn === 1) {
    facts.push(es ? "da mate" : "delivers checkmate");
  }

  if (best.captured !== null) {
    const victim = best.captured;
    // A pawn taking a pawn onto the en passant rank may be en passant, where the victim is not on
    // the destination square. The DTO cannot tell, so name the square only when it is certain.
    const mayBeEnPassant = best.piece === "pawn" && victim === "pawn" && isEnPassantStep(best.move);
    if (mayBeEnPassant) {
      facts.push(es ? "captura un peón" : "captures a pawn");
    } else {
      const square = best.move.slice(2, 4);
      facts.push(
        es
          ? `captura ${article(victim, locale)} ${piece(victim, locale)} de ${square}`
          : `captures the ${piece(victim, locale)} on ${square}`
      );
    }
  }

  if (best.savesThreatened) {
    const saved = explanation.threatened[0];
    if (saved !== undefined) {
      facts.push(
        es
          ? `pone a salvo tu ${piece(saved.piece, locale)}`
          : `saves your ${piece(saved.piece, locale)}`
      );
    }
  }

  if (best.check && !best.mate) {
    facts.push(es ? "da jaque" : "gives check");
  }

  const threat: SideExploreExplanationSquareDto | undefined = best.threats[0];
  if (threat !== undefined && !best.mate) {
    facts.push(
      es
        ? `ataca ${article(threat.piece, locale)} ${piece(threat.piece, locale)} de ${threat.square}`
        : `attacks the ${piece(threat.piece, locale)} on ${threat.square}`
    );
  }

  if (best.castle !== null) {
    facts.push(es ? "enroca y protege al rey" : "castles and protects the king");
  }

  if (best.promotion !== null) {
    facts.push(
      es
        ? `corona el peón a ${piece(best.promotion, locale)}`
        : `promotes the pawn to a ${piece(best.promotion, locale)}`
    );
  }

  if (candidate.sacrifice) {
    facts.push(
      es
        ? "sacrifica la pieza a cambio de iniciativa"
        : "sacrifices the piece in exchange for the initiative"
    );
  }

  if (explanation.inCheck) {
    facts.push(es ? "te saca del jaque" : "gets you out of check");
  }

  return facts;
}

function lineOutcome(
  explanation: SideExploreExplanationDto,
  candidate: ExplainedCandidate,
  locale: ExplanationLocale
): string | null {
  const gain = explanation.lineMaterialCp;
  if (candidate.mateIn !== null || gain < minLineGainCp || candidate.exactScoreCp < minLineScoreCp) {
    return null;
  }
  // Buckets: pawn ~100, exchange ~200, minor piece ~320-330, rook ~500, queen >= 850.
  const es = locale === "es";
  let what: string;
  if (gain < 150) {
    what = es ? "un peón" : "a pawn";
  } else if (gain < 250) {
    what = es ? "la calidad" : "the exchange";
  } else if (gain < 450) {
    what = es ? "una pieza" : "a piece";
  } else if (gain < 850) {
    what = es ? "una torre" : "a rook";
  } else {
    what = es ? "la dama" : "the queen";
  }
  return es ? `La línea gana ${what}.` : `The line wins ${what}.`;
}

/// White pawn from rank 5 to rank 6, or black pawn from rank 4 to rank 3, moving diagonally.
function isEnPassantStep(move: string): boolean {
  const diagonal = move[0] !== move[2];
  return diagonal && ((move[1] === "5" && move[3] === "6") || (move[1] === "4" && move[3] === "3"));
}

function piece(kind: ExplanationPieceDto, locale: ExplanationLocale): string {
  return pieceWords[locale][kind].name;
}

function article(kind: ExplanationPieceDto, locale: ExplanationLocale): string {
  return pieceWords[locale][kind].article;
}
