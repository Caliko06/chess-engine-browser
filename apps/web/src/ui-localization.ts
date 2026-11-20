export type UiLocale = "es" | "en";

export const defaultUiLocale: UiLocale = "es";

type UiCopy = {
  readonly locale: UiLocale;
  readonly play: string;
  readonly trainer: string;
  readonly badge: string;
  readonly scope: string;
  readonly undo: string;
  readonly resign: string;
  readonly resignUser: string;
  readonly resignRival: string;
  readonly newGame: string;
  readonly review: string;
  readonly save: string;
  readonly settings: string;
  readonly mode: string;
  readonly side: string;
  readonly depth: string;
  readonly reviewDepth: string;
  readonly style: string;
  readonly opponent: string;
  readonly spectator: string;
  readonly explore: string;
  readonly setup: string;
  readonly white: string;
  readonly black: string;
  readonly aggressive: string;
  readonly loading: string;
  readonly failed: string;
  readonly ready: string;
  readonly thinking: string;
  readonly checkmate: string;
  readonly stalemate: string;
  readonly draw: string;
  readonly yourMove: string;
  readonly engineMove: string;
  readonly user: string;
  readonly rival: string;
  readonly reviewing: string;
  readonly reviewComplete: string;
  readonly needsAttention: string;
  readonly language: string;
  readonly exploreSurface: ExploreSurfaceCopy;
  readonly analyzerSurface: AnalyzerSurfaceCopy;
};

type AnalyzerSurfaceCopy = {
  readonly section: string;
  readonly hint: string;
  readonly pgnLabel: string;
  readonly pgnPlaceholder: string;
  readonly sideLabel: string;
  readonly fileLabel: string;
  readonly fileButton: string;
  readonly fileNone: string;
  readonly currentGame: string;
  readonly depthLabel: string;
  readonly analyzeButton: string;
  readonly analyzing: string;
  readonly endpointUnavailable: string;
  readonly invalidPgn: string;
  readonly analysisFailed: string;
  readonly invalidReport: string;
  readonly reportTitle: string;
  readonly oracleLabel: string;
  readonly oracleEnabled: string;
  readonly oracleDegraded: string;
  readonly oracleUnavailable: string;
  readonly quarantineTitle: string;
  readonly quarantineNoReasons: string;
  readonly noGames: string;
  readonly verdictLosses: string;
  readonly verdictPawns: string;
  readonly verdictNone: string;
  readonly verdictWorst: string;
  readonly bestLabel: string;
  readonly rivalTag: string;
  readonly userTag: string;
  readonly attentionTitle: string;
  readonly attentionNone: string;
  readonly noDelta: string;
  readonly lostKing: string;
  readonly missedMate: string;
  readonly bandBest: string;
  readonly bandGood: string;
  readonly bandInaccuracy: string;
  readonly bandMistake: string;
  readonly bandBlunder: string;
  readonly bandMateTransition: string;
  readonly stripTitle: string;
  readonly ownedNote: string;
};

type ExploreSurfaceCopy = {
  readonly brand: string;
  readonly engine: string;
  readonly classicBadge: string;
  readonly aggressiveOn: string;
  readonly primaryGates: string;
  readonly primaryGatesHint: string;
  readonly sessionControl: string;
  readonly sessionControlHint: string;
  readonly tools: string;
  readonly moreTools: string;
  readonly moves: string;
  readonly movesArchiveEvidence: string;
  readonly postGameReview: string;
  readonly gameComplete: string;
  readonly rematch: string;
  readonly reviewGame: string;
  readonly playSession: string;
  readonly board: string;
  readonly boardAria: string;
  readonly emptySquare: string;
  readonly whitePiece: string;
  readonly blackPiece: string;
  readonly boardPieces: Readonly<Record<"king" | "queen" | "rook" | "bishop" | "knight" | "pawn", string>>;
  readonly liveBoard: string;
  readonly whatToPlayNow: string;
  readonly position: string;
  readonly view: string;
  readonly player: string;
  readonly turn: string;
  readonly status: string;
  readonly selection: string;
  readonly noSelection: string;
  readonly lastSearch: string;
  readonly none: string;
  readonly technicalPosition: string;
  readonly fenCopy: string;
  readonly loadPosition: string;
  readonly fen: string;
  readonly exploreOptions: string;
  readonly reactionMap: string;
  readonly forcing: string;
  readonly engineDepth: string;
  readonly reactionDepth: string;
  readonly fast: string;
  readonly deep: string;
  readonly recommendation: string;
  readonly showOnBoard: string;
  readonly showResponsePlan: string;
  readonly alternatives: string;
  readonly alternativesHint: string;
  readonly rivalAlternatives: string;
  readonly rivalAlternativesHint: string;
  readonly alternativesEmpty: string;
  readonly bestIdea: string;
  readonly projectedIdea: string;
  readonly riskChoice: string;
  readonly evaluation: string;
  readonly riskEvaluation: string;
  readonly projectedEvaluation: string;
  readonly risk: string;
  readonly moreDetail: string;
  readonly contextEvidence: string;
  readonly deepenReading: string;
  readonly deepenReadingHint: string;
  readonly context: string;
  readonly side: string;
  readonly white: string;
  readonly black: string;
  readonly candidates: string;
  readonly sacrifice: string;
  readonly mate: string;
  readonly mode: string;
  readonly objective: string;
  readonly rivalVariant: string;
  readonly rivalBest: string;
  readonly followUp: string;
  readonly continuation: string;
  readonly plan: string;
  readonly result: string;
  readonly stage: string;
  readonly opening: string;
  readonly searchDetail: string;
  readonly completedDepth: string;
  readonly nodes: string;
  readonly sideExplorerReport: string;
  readonly sideExplorerHint: string;
  readonly cliCopy: string;
  readonly cliCopied: string;
  readonly cliCopyUnavailable: string;
  readonly signals: string;
  readonly pathSignals: string;
  readonly line: string;
  readonly alternativeRole: string;
  readonly alternative: string;
  readonly caution: string;
  readonly hanging: string;
  readonly arrowRoles: string;
  readonly leastBadRisk: string;
  readonly riskyAlternative: string;
  readonly avoid: string;
  readonly verified: string;
  readonly mated: string;
  readonly forcedMate: string;
  readonly mateIn: string;
  readonly followed: string;
  readonly replaced: string;
  readonly continuationIllegal: string;
  readonly recomputed: string;
  readonly richResult: string;
  readonly richSearchRunning: string;
  readonly richSearchUnavailable: string;
  readonly fallbackSearchRunning: string;
  readonly provisionalUncertified: string;
  readonly independent: string;
  readonly next: string;
  readonly projected: string;
  readonly waiting: string;
  readonly liveBoardStatus: string;
  readonly aggressiveLine: string;
  readonly bestLine: string;
  readonly projectedLine: string;
  readonly aggressiveTieBreak: string;
  readonly userResponse: string;
  readonly rivalReplyFirst: string;
  readonly projectedResponse: string;
  readonly bestOutcomeFor: string;
  readonly oracleRefutedCandidates: string;
  readonly refutedRequiresNewProof: string;
  readonly brilliantCandidate: string;
  readonly on: string;
  readonly off: string;
  readonly preparing: string;
  readonly calculating: string;
  readonly live: string;
  readonly provisional: string;
  readonly unavailable: string;
  readonly preparingRecommendation: string;
  readonly pendingRecommendation: string;
  readonly provisionalRecommendation: string;
  readonly unavailableRecommendation: string;
  readonly noValue: string;
  readonly playMove: string;
  readonly afterMoveLead: string;
  readonly prepareMove: string;
  readonly verifiedReason: string;
  readonly riskIntro: string;
  readonly riskReason: string;
  readonly sacrificeReason: string;
  readonly waitingReason: string;
  readonly promotion: string;
  readonly afterMove: string;
  readonly waitingOnRival: string;
  readonly notRecommendedScore: string;
  readonly pendingNote: string;
  readonly provisionalNote: string;
  readonly riskNote: string;
  readonly unavailableNote: string;
};

export const uiCopy: Readonly<Record<UiLocale, UiCopy>> = {
  es: {
    locale: "es",
    play: "Jugar",
    trainer: "Explore",
    badge: "Explore",
    scope: "Revisión local y práctica visual",
    undo: "Deshacer",
    resign: "Abandonar",
    resignUser: "Se rinde: usuario",
    resignRival: "Se rinde: rival",
    newGame: "Nueva partida",
    review: "Revisar",
    save: "Guardar",
    settings: "Configuración de juego",
    mode: "Modo",
    side: "Lado",
    depth: "Fuerza",
    reviewDepth: "Profundidad de revisión",
    style: "Estilo",
    opponent: "Oponente",
    spectator: "Analizar",
    explore: "Explorar",
    setup: "Preparar",
    white: "Blancas",
    black: "Negras",
    aggressive: "Agresivo",
    loading: "Cargando",
    failed: "No disponible",
    ready: "Listo",
    thinking: "Pensando",
    checkmate: "Jaque mate",
    stalemate: "Ahogado",
    draw: "Tablas",
    yourMove: "Tu turno",
    engineMove: "Turno del motor",
    user: "Usuario",
    rival: "Rival",
    reviewing: "Revisando",
    reviewComplete: "Revisión completa",
    needsAttention: "Requiere atención",
    language: "English",
    exploreSurface: {
      brand: "CHESS / EXPLORE",
      engine: "Análisis local",
      classicBadge: "CLÁSICA",
      aggressiveOn: "AGRESIVO ACTIVO",
      primaryGates: "Lectura",
      primaryGatesHint: "Lado · profundidad",
      sessionControl: "Más opciones",
      sessionControlHint: "Motor · modo",
      tools: "Herramientas",
      moreTools: "Más herramientas",
      moves: "Movimientos",
      movesArchiveEvidence: "Movimientos · Archivo · Evidencia",
      postGameReview: "Revisión posterior",
      gameComplete: "Partida completa",
      rematch: "Revancha",
      reviewGame: "Revisar partida",
      playSession: "Sesión de juego",
      board: "Tablero",
      boardAria: "Tablero de ajedrez",
      emptySquare: "vacía",
      whitePiece: "blanca",
      blackPiece: "negra",
      boardPieces: {
        king: "rey",
        queen: "dama",
        rook: "torre",
        bishop: "alfil",
        knight: "caballo",
        pawn: "peón"
      },
      liveBoard: "TABLERO ACTUAL",
      whatToPlayNow: "Qué jugar ahora",
      position: "Posición",
      view: "Vista",
      player: "Juegas con",
      turn: "Turno",
      status: "Estado",
      selection: "Selección",
      noSelection: "Sin selección",
      lastSearch: "Última búsqueda",
      none: "Ninguno",
      technicalPosition: "Posición técnica",
      fenCopy: "FEN · copiar",
      loadPosition: "Cargar posición",
      fen: "FEN",
      exploreOptions: "Opciones de análisis",
      reactionMap: "Mapa de reacción",
      forcing: "Forzadas",
      engineDepth: "Profundidad del motor",
      reactionDepth: "Detalle de reacción",
      fast: "Rápido",
      deep: "Profundo",
      recommendation: "Siguiente decisión",
      showOnBoard: "Ver en tablero",
      showResponsePlan: "Ver respuesta y plan",
      alternatives: "Otras jugadas",
      alternativesHint: "Alternativas marcadas en el tablero",
      rivalAlternatives: "Respuestas rivales",
      rivalAlternativesHint: "Variantes después de la jugada principal",
      alternativesEmpty: "No hay otra variante sólida en este corte.",
      bestIdea: "Jugada recomendada",
      projectedIdea: "Respuesta proyectada",
      riskChoice: "Opción menos riesgosa",
      evaluation: "Evaluación",
      riskEvaluation: "Evaluación",
      projectedEvaluation: "Evaluación proyectada",
      risk: "Riesgo",
      moreDetail: "Más detalle",
      contextEvidence: "Contexto · evidencia",
      deepenReading: "Profundizar",
      deepenReadingHint: "Ajusta la lectura o abre la evidencia",
      context: "Contexto",
      side: "Lado",
      white: "Blancas",
      black: "Negras",
      candidates: "Candidatas",
      sacrifice: "Sacrificio",
      mate: "Mate",
      mode: "Modo",
      objective: "Objetivo",
      rivalVariant: "Variante rival",
      rivalBest: "Mejor rival",
      followUp: "Seguimiento",
      continuation: "continuación",
      plan: "Plan",
      result: "Resultado",
      stage: "Etapa",
      opening: "Apertura",
      searchDetail: "Detalle de búsqueda",
      completedDepth: "Profundidad alcanzada",
      nodes: "Nodos",
      sideExplorerReport: "Side-explore · motor propio",
      sideExplorerHint: "Candidatas del motor en este turno",
      cliCopy: "Copiar comando",
      cliCopied: "Comando copiado",
      cliCopyUnavailable: "Copia no disponible",
      signals: "Señales",
      pathSignals: "Señales del recorrido",
      line: "Línea",
      alternativeRole: "Alternativa",
      alternative: "Alterna",
      caution: "Cuidado",
      hanging: "Pieza colgada",
      arrowRoles: "Roles de flecha",
      leastBadRisk: "Menor riesgo",
      riskyAlternative: "Alternativa arriesgada",
      avoid: "Evitar",
      verified: "Verificada",
      mated: "Mate recibido",
      forcedMate: "Mate forzado",
      mateIn: "Mate en",
      followed: "Mantenido",
      replaced: "Reemplazado",
      continuationIllegal: "continuación ilegal",
      recomputed: "tablero recalculado",
      richResult: "Resultado completo",
      richSearchRunning: "Búsqueda completa en curso",
      richSearchUnavailable: "Búsqueda completa no disponible",
      fallbackSearchRunning: "Respaldo rápido · búsqueda completa en curso",
      provisionalUncertified: "provisional · sin certificar",
      independent: "Independiente",
      next: "Siguiente",
      projected: "Proyectada",
      waiting: "Esperando",
      liveBoardStatus: "tablero actual",
      aggressiveLine: "Línea agresiva para",
      bestLine: "Mejor línea para",
      projectedLine: "Línea proyectada para",
      aggressiveTieBreak: "Mejor jugada primero · desempate agresivo",
      userResponse: "respuesta del usuario",
      rivalReplyFirst: "Respuesta rival primero",
      projectedResponse: "respuesta proyectada",
      bestOutcomeFor: "Mejor resultado para",
      oracleRefutedCandidates: "Candidatas refutadas por el oráculo",
      refutedRequiresNewProof: "refutada por el oráculo; requiere una prueba nueva",
      brilliantCandidate: "Candidata brillante",
      on: "Activo",
      off: "Inactivo",
      preparing: "Preparando",
      calculating: "Calculando…",
      live: "En vivo",
      provisional: "Provisional",
      unavailable: "No disponible",
      preparingRecommendation: "Preparando recomendación",
      pendingRecommendation: "Analizando posición",
      provisionalRecommendation: "Jugada provisional",
      unavailableRecommendation: "Recomendación no disponible",
      noValue: "—",
      playMove: "Juega",
      afterMoveLead: "Después de",
      prepareMove: "prepara",
      verifiedReason: "es la opción verificada para tu lado.",
      riskIntro: "Si necesitas elegir, usa",
      riskReason: "es el menor riesgo disponible, pero no está verificada.",
      sacrificeReason: "el sacrificio está verificado.",
      waitingReason: "Espera la respuesta rival para elegir la continuación.",
      promotion: "promoción a",
      afterMove: "después de",
      waitingOnRival: "Esperando respuesta",
      notRecommendedScore: "no recomendada · exacta",
      pendingNote: "El motor está calculando la posición localmente.",
      provisionalNote: "Resultado provisional; la búsqueda completa sigue en curso.",
      riskNote: "La opción principal no está verificada.",
      unavailableNote: "Revisa Más opciones para continuar."
    },
    analyzerSurface: {
      section: "Analizador",
      hint: "Análisis local con Stockfish",
      pgnLabel: "PGN de la partida",
      pgnPlaceholder: "Pega aquí un PGN…",
      sideLabel: "Tu lado",
      fileLabel: "O carga un archivo",
      fileButton: "Cargar PGN",
      fileNone: "Sin archivo",
      currentGame: "Usar la partida actual",
      depthLabel: "Profundidad",
      analyzeButton: "Analizar partida",
      analyzing: "Analizando",
      endpointUnavailable: "El analizador necesita el servidor local. Arráncalo con just preview.",
      invalidPgn: "El PGN no es válido. Revisa la notación y vuelve a intentarlo.",
      analysisFailed: "El análisis falló. Prueba con otra profundidad o revisa el reporte JSON.",
      invalidReport: "El reporte no se pudo leer. Vuelve a analizar la partida.",
      reportTitle: "Reporte del análisis",
      oracleLabel: "Oráculo",
      oracleEnabled: "Stockfish activo",
      oracleDegraded: "Stockfish parcial",
      oracleUnavailable: "Sin Stockfish local",
      quarantineTitle: "Partida en cuarentena",
      quarantineNoReasons: "Ver razones en el reporte JSON.",
      noGames: "Sin partidas aceptadas.",
      verdictLosses: "Tus jugadas dañinas costaron",
      verdictPawns: "peones",
      verdictNone: "Sin jugadas dañinas detectadas.",
      verdictWorst: "la peor",
      bestLabel: "Mejor",
      rivalTag: "Rival",
      userTag: "Tú",
      attentionTitle: "Qué revisar",
      attentionNone: "Nada destacado: partida sólida.",
      noDelta: "Sin comparación",
      lostKing: "pierde el rey",
      missedMate: "el mate se escapa",
      bandBest: "Excelente",
      bandGood: "Bien",
      bandInaccuracy: "Imprecisión",
      bandMistake: "Error",
      bandBlunder: "Blunder",
      bandMateTransition: "Mate",
      stripTitle: "Tira de jugadas",
      ownedNote: "comparación con el motor propio activa"
    }
  },
  en: {
    locale: "en",
    play: "Play",
    trainer: "Explore",
    badge: "Explore",
    scope: "Local review and visual retry practice",
    undo: "Undo",
    resign: "Resign",
    resignUser: "User resigns",
    resignRival: "Rival resigns",
    newGame: "New Game",
    review: "Review",
    save: "Save",
    settings: "Play settings",
    mode: "Mode",
    side: "Side",
    depth: "Strength",
    reviewDepth: "Review depth",
    style: "Style",
    opponent: "Opponent",
    spectator: "Analyze",
    explore: "Explore",
    setup: "Setup",
    white: "White",
    black: "Black",
    aggressive: "Aggressive",
    loading: "Loading",
    failed: "Failed",
    ready: "Ready",
    thinking: "Thinking",
    checkmate: "Checkmate",
    stalemate: "Stalemate",
    draw: "Draw",
    yourMove: "Your move",
    engineMove: "Engine move",
    user: "User",
    rival: "Rival",
    reviewing: "Reviewing",
    reviewComplete: "Review complete",
    needsAttention: "Needs attention",
    language: "Español",
    exploreSurface: {
      brand: "CHESS / EXPLORE",
      engine: "Local analysis",
      classicBadge: "CLASSICAL",
      aggressiveOn: "AGGRESSIVE ON",
      primaryGates: "Reading",
      primaryGatesHint: "Side · depth",
      sessionControl: "More options",
      sessionControlHint: "Engine · mode",
      tools: "Tools",
      moreTools: "More tools",
      moves: "Moves",
      movesArchiveEvidence: "Moves · Archive · Evidence",
      postGameReview: "Post-game review",
      gameComplete: "Game complete",
      rematch: "Rematch",
      reviewGame: "Review game",
      playSession: "Play session",
      board: "Board",
      boardAria: "Chess board",
      emptySquare: "empty",
      whitePiece: "white",
      blackPiece: "black",
      boardPieces: {
        king: "king",
        queen: "queen",
        rook: "rook",
        bishop: "bishop",
        knight: "knight",
        pawn: "pawn"
      },
      liveBoard: "LIVE BOARD",
      whatToPlayNow: "What to play now",
      position: "Position",
      view: "View",
      player: "Playing as",
      turn: "Turn",
      status: "Status",
      selection: "Selection",
      noSelection: "No selection",
      lastSearch: "Last search",
      none: "None",
      technicalPosition: "Technical position",
      fenCopy: "FEN · copy",
      loadPosition: "Load position",
      fen: "FEN",
      exploreOptions: "Analysis options",
      reactionMap: "Reaction map",
      forcing: "Forcing",
      engineDepth: "Engine depth",
      reactionDepth: "Reaction detail",
      fast: "Fast",
      deep: "Deep",
      recommendation: "Next decision",
      showOnBoard: "View on board",
      showResponsePlan: "View reply and plan",
      alternatives: "Other moves",
      alternativesHint: "Alternatives marked on the board",
      rivalAlternatives: "Rival replies",
      rivalAlternativesHint: "Lines after the main move",
      alternativesEmpty: "No other sound line in this search window.",
      bestIdea: "Best idea",
      projectedIdea: "Projected idea",
      riskChoice: "Least bad risk",
      evaluation: "Exact score",
      riskEvaluation: "Risk",
      projectedEvaluation: "Projected score",
      risk: "Risk",
      moreDetail: "More detail",
      contextEvidence: "Context · evidence",
      deepenReading: "Go deeper",
      deepenReadingHint: "Tune the read or open the evidence",
      context: "Context",
      side: "Side",
      white: "White",
      black: "Black",
      candidates: "Candidates",
      sacrifice: "Sacrifice",
      mate: "Mate",
      mode: "Mode",
      objective: "Objective",
      rivalVariant: "Rival variant",
      rivalBest: "Rival best",
      followUp: "Follow-up",
      continuation: "continuation",
      plan: "Plan",
      result: "Result",
      stage: "Stage",
      opening: "Opening",
      searchDetail: "Search detail",
      completedDepth: "Completed depth",
      nodes: "Nodes",
      sideExplorerReport: "Side-explore · owned engine",
      sideExplorerHint: "Engine candidates this turn",
      cliCopy: "Copy command",
      cliCopied: "Command copied",
      cliCopyUnavailable: "Copy unavailable",
      signals: "Signals",
      pathSignals: "Path signals",
      line: "Line",
      alternativeRole: "Alternative",
      alternative: "Alt",
      caution: "Caution",
      hanging: "Hanging",
      arrowRoles: "Arrow roles",
      leastBadRisk: "Least bad risk",
      riskyAlternative: "Risky alternative",
      avoid: "Avoid",
      verified: "Verified",
      mated: "Mated",
      forcedMate: "Forced mate",
      mateIn: "Mate in",
      followed: "Followed",
      replaced: "Replaced",
      continuationIllegal: "continuation illegal",
      recomputed: "live board recomputed",
      richResult: "Rich result",
      richSearchRunning: "Rich search running",
      richSearchUnavailable: "Rich search unavailable",
      fallbackSearchRunning: "Fallback depth 1 · rich search running",
      provisionalUncertified: "provisional · uncertified",
      independent: "Independent",
      next: "Next",
      projected: "Projected",
      waiting: "Waiting",
      liveBoardStatus: "live board",
      aggressiveLine: "Aggressive line for",
      bestLine: "Best line for",
      projectedLine: "Projected line for",
      aggressiveTieBreak: "Best move first · aggressive tie-break",
      userResponse: "user response",
      rivalReplyFirst: "Rival reply first",
      projectedResponse: "projected response",
      bestOutcomeFor: "Best outcome for",
      oracleRefutedCandidates: "Oracle-refuted candidates",
      refutedRequiresNewProof: "refuted by the oracle; requires a new proof",
      brilliantCandidate: "Brilliant candidate",
      on: "On",
      off: "Off",
      preparing: "Preparing",
      calculating: "Calculating…",
      live: "Live",
      provisional: "Provisional",
      unavailable: "Unavailable",
      preparingRecommendation: "Preparing recommendation",
      pendingRecommendation: "Analyzing position",
      provisionalRecommendation: "Provisional move",
      unavailableRecommendation: "Recommendation unavailable",
      noValue: "—",
      playMove: "Play",
      afterMoveLead: "After",
      prepareMove: "prepare",
      verifiedReason: "is the verified option for your side.",
      riskIntro: "If you must choose, use",
      riskReason: "is the least-risk option available, but it is not verified.",
      sacrificeReason: "the sacrifice is verified.",
      waitingReason: "Wait for the rival reply to choose the continuation.",
      promotion: "promotion to",
      afterMove: "after",
      waitingOnRival: "Waiting for reply",
      notRecommendedScore: "not recommended · exact",
      pendingNote: "The local engine is calculating this position.",
      provisionalNote: "Provisional result; the full search is still running.",
      riskNote: "The primary option is not verified.",
      unavailableNote: "Review More options to continue."
    },
    analyzerSurface: {
      section: "Analyzer",
      hint: "Local Stockfish analysis",
      pgnLabel: "Game PGN",
      pgnPlaceholder: "Paste a PGN here…",
      sideLabel: "Your side",
      fileLabel: "Or load a file",
      fileButton: "Load PGN",
      fileNone: "No file",
      currentGame: "Use current game",
      depthLabel: "Depth",
      analyzeButton: "Analyze game",
      analyzing: "Analyzing",
      endpointUnavailable: "The analyzer needs the local server. Start it with just preview.",
      invalidPgn: "The PGN is not valid. Check the notation and try again.",
      analysisFailed: "The analysis failed. Try another depth or check the JSON report.",
      invalidReport: "The report could not be read. Analyze the game again.",
      reportTitle: "Analysis report",
      oracleLabel: "Oracle",
      oracleEnabled: "Stockfish active",
      oracleDegraded: "Stockfish partial",
      oracleUnavailable: "No local Stockfish",
      quarantineTitle: "Game quarantined",
      quarantineNoReasons: "See the JSON report for reasons.",
      noGames: "No accepted games.",
      verdictLosses: "Your damaging moves cost",
      verdictPawns: "pawns",
      verdictNone: "No damaging moves detected.",
      verdictWorst: "the worst",
      bestLabel: "Best",
      rivalTag: "Rival",
      userTag: "You",
      attentionTitle: "What to review",
      attentionNone: "Nothing highlighted: solid game.",
      noDelta: "No comparison",
      lostKing: "loses the king",
      missedMate: "missed mate",
      bandBest: "Excellent",
      bandGood: "Good",
      bandInaccuracy: "Inaccuracy",
      bandMistake: "Mistake",
      bandBlunder: "Blunder",
      bandMateTransition: "Mate",
      stripTitle: "Move strip",
      ownedNote: "owned-engine comparison active"
    }
  }
};

export function copyFor(locale: UiLocale): UiCopy {
  return uiCopy[locale];
}

const visibleSpanishPairs: readonly [string, string][] = [
  [">Play<", ">Jugar<"],
  [">Undo<", ">Deshacer<"],
  [">Resign<", ">Abandonar<"],
  [">User<", ">Usuario<"],
  [">Rival<", ">Rival<"],
  [">Resigned by<", ">Se rindió<"],
  [">New Game<", ">Nueva partida<"],
  [">Mode<", ">Modo<"],
  [">Side<", ">Lado<"],
  [">Depth<", ">Profundidad<"],
  [">Style<", ">Estilo<"],
  [">Eval<", ">Evaluación<"],
  [">Classical<", ">Clásica<"],
  [">White<", ">Blancas<"],
  [">Black<", ">Negras<"],
  [">Board<", ">Tablero<"],
  [">White to move<", ">Turno de blancas<"],
  [">Black to move<", ">Turno de negras<"],
  [">Engine: Owned local<", ">Motor local propio<"],
  [">CLASSIC<", ">CLÁSICA<"],
  [">AGGRESSIVE ON<", ">AGRESIVO ACTIVO<"],
  [">Aggressive: On<", ">Agresivo: Activo<"],
  [">Aggressive: Off<", ">Agresivo: Inactivo<"],
  [">Agresivo: On<", ">Agresivo: Activo<"],
  [">Agresivo: Off<", ">Agresivo: Inactivo<"],
  [">Turn<", ">Turno<"],
  [">Status<", ">Estado<"],
  [">Candidates<", ">Candidatas<"],
  [">Best idea<", ">Mejor idea<"],
  [">Exact score<", ">Puntuación exacta<"],
  [">None<", ">Ninguno<"],
  [">Objective<", ">Objetivo<"],
  [">Plan<", ">Plan<"],
  [">Result<", ">Resultado<"],
  [">Stage<", ">Etapa<"],
  [">Opening<", ">Apertura<"],
  [">Completed depth<", ">Profundidad alcanzada<"],
  [">Nodes<", ">Nodos<"],
  [">Last search<", ">Última búsqueda<"],
  [">No selection<", ">Sin selección<"],
  [">Tools<", ">Herramientas<"],
  [">Fast<", ">Rápido<"],
  [">Deep<", ">Profundo<"],
  [">Live board<", ">Tablero actual<"],
  [">live board<", ">tablero actual<"],
  [">none<", ">ninguno<"],
  [">ongoing<", ">en curso<"],
  [">FEN · copy<", ">FEN · copiar<"],
  [">Aggressive line for White<", ">Línea agresiva para blancas<"],
  [">Aggressive line for Black<", ">Línea agresiva para negras<"],
  [">Best move first · aggressive tie-break<", ">Mejor jugada primero · desempate agresivo<"],
  [">Classic rich result<", ">Resultado clásico completo<"],
  [">Least bad risk<", ">Menor riesgo<"],
  [">Risky alternative<", ">Alternativa arriesgada<"],
  [">Avoid<", ">Evitar<"],
  [">Risk<", ">Riesgo<"],
  [">caution<", ">cuidado<"],
  [">Fallback depth 1 · rich search running<", ">Profundidad de respaldo 1 · búsqueda completa en curso<"],
  [">Classic rich search running<", ">Búsqueda clásica completa en curso<"],
  [">Classic rich search unavailable<", ">Búsqueda clásica no disponible<"],
  [">unavailable<", ">no disponible<"],
  [">Analyze<", ">Analizar<"],
  [">Explore<", ">Explorar<"],
  [">Analysis<", ">Análisis<"],
  [">SESSION CONTROL<", ">CONTROL DE SESIÓN<"],
  [">Classic engine · local analysis<", ">Motor Classic · análisis local<"],
  [">LIVE BOARD<", ">TABLERO EN VIVO<"],
  [">DECISION RAIL<", ">PANEL DE DECISIÓN<"],
  [">Take back the last turn<", ">Retira el último turno<"],
  [">Live position<", ">Posición en vivo<"],
  [">Live<", ">En vivo<"],
  [">Calculating<", ">Calculando<"],
  [">Unavailable<", ">No disponible<"],
  [">Signals<", ">Señales<"],
  [">Context<", ">Contexto<"],
  [">Recommendation<", ">Recomendación<"],
  [">Search detail<", ">Detalle de búsqueda<"],
  [">More detail<", ">Más detalle<"],
  [">Context · evidence<", ">Contexto · evidencia<"],
  [">Reaction map<", ">Mapa de reacción<"],
  [">Forcing<", ">Forzadas<"],
  [">Rival variant<", ">Variante rival<"],
  [">Rival best<", ">Mejor rival<"],
  [">Line<", ">Línea<"],
  [">Alt<", ">Alterna<"],
  [">Sacrifice<", ">Sacrificio<"],
  [">Caution<", ">Cuidado<"],
  [">Hanging<", ">Pieza colgada<"],
  [">Setup<", ">Preparar<"],
  [">Ready<", ">Listo<"],
  [">Thinking<", ">Pensando<"],
  [">Your move<", ">Tu turno<"],
  [">Engine move<", ">Turno del motor<"]
  , [">Review<", ">Revisar<"]
  , [">Save<", ">Guardar<"]
  , [">Clear saved reviews<", ">Borrar revisiones guardadas<"]
  , [">Cancel<", ">Cancelar<"]
  , [">Confirm<", ">Confirmar<"]
  , [">Copy PGN<", ">Copiar PGN<"]
  , [">Evidence<", ">Evidencia<"]
  , [">Coach artifacts<", ">Artefactos del entrenador<"]
  , [">No evidence<", ">Sin evidencia<"]
  , [">No review yet<", ">Aún no hay revisión<"]
  , [">Key moments<", ">Momentos clave<"]
  , [">No key moments<", ">Sin momentos clave<"]
  , [">Summary<", ">Resumen<"]
  , [">Moves<", ">Movimientos<"]
  , [">Saved reviews<", ">Revisiones guardadas<"]
  , [">No saved reviews<", ">Sin revisiones guardadas<"]
  , [">Retry practice<", ">Práctica de reintento<"]
  , [">Lens<", ">Lente<"]
  , [">Load<", ">Cargar<"]
  , [">Load position<", ">Cargar posición<"]
  , [">No forcing idea<", ">Sin idea forzada<"]
  , [">No legal moves<", ">Sin jugadas legales<"]
  , [">No moves<", ">Sin jugadas<"]
  , [">Position<", ">Posición<"]
  , [">Rematch<", ">Revancha<"]
  , [">Review game<", ">Revisar partida<"]
  , [">Save Game<", ">Guardar partida<"]
  , [">Save Test Session<", ">Guardar sesión de prueba<"]
  , [">Searching forcing moves…<", ">Buscando jugadas forzadas…<"]
  , [">Selection<", ">Selección<"]
  , [">Setup board<", ">Preparar tablero<"]
  , [">Best<", ">Mejor<"]
  , [">Best move<", ">Mejor jugada<"]
  , [">Best score<", ">Mejor puntuación<"]
  , [">CP loss<", ">Pérdida de CP<"]
  , [">Check<", ">Jaque<"]
  , [">Clear saved reviews?<", ">¿Borrar revisiones guardadas?<"]
  , [">Early divergences<", ">Divergencias tempranas<"]
  , [">Label<", ">Etiqueta<"]
  , [">Local saved retry positions<", ">Posiciones guardadas de reintento<"]
  , [">Move list<", ">Lista de jugadas<"]
  , [">Next<", ">Siguiente<"]
  , [">Play analysis JSON<", ">JSON de análisis de Play<"]
  , [">Play evidence report<", ">Reporte de evidencia de Play<"]
  , [">No report imported<", ">No se importó ningún reporte<"]
  , [">Oracle<", ">Oráculo<"]
  , [">Oracle depth<", ">Profundidad del oráculo<"]
  , [">Games<", ">Partidas<"]
  , [">No accepted games<", ">No hay partidas aceptadas<"]
  , [">Selected side<", ">Lado seleccionado<"]
  , [">Aggressive<", ">Agresivo<"]
  , [">Played<", ">Jugó<"]
  , [">Play level<", ">Nivel de Play<"]
  , [">Move depth<", ">Profundidad de la jugada<"]
  , [">Oracle<", ">Oráculo<"]
  , [">No candidates captured<", ">No se capturaron candidatas<"]
  , [">score unknown<", ">puntuación desconocida<"]
  , [">sound<", ">sólida<"]
  , [">not sound<", ">no sólida<"]
  , [">played<", ">jugada<"]
  , [">not offered<", ">no ofrecida<"]
  , [">primary<", ">principal<"]
  , [">no result<", ">sin resultado<"]
  , [">user plies<", ">plies del usuario<"]
  , [">Analysis report could not be read<", ">No se pudo leer el reporte de análisis<"]
  , [">primary<", ">principal<"]
  , [">candidate 2<", ">candidata 2<"]
  , [">candidate 3<", ">candidata 3<"]
  , [">candidate 4<", ">candidata 4<"]
  , [">true<", ">sí<"]
  , [">false<", ">no<"]
  , [">unknown<", ">desconocido<"]
  , [">white<", ">blancas<"]
  , [">black<", ">negras<"]
  , [">fast<", ">rápida<"]
  , [">none<", ">ninguno<"]
];

export function localizeVisibleMarkup(markup: string, locale: UiLocale): string {
  if (locale === "en") {
    return markup;
  }
  const localized = visibleSpanishPairs.reduce(
    (current, [english, spanish]) => current.replaceAll(english, spanish),
    markup
  );
  return localized
    .replaceAll("Independent ·", "Independiente ·")
    .replaceAll("Independiente · unavailable", "Independiente · no disponible")
    .replaceAll(">White next<", ">Siguiente de blancas<")
    .replaceAll(">Black next<", ">Siguiente de negras<")
    .replaceAll(">White projected<", ">Proyección de blancas<")
    .replaceAll(">Black projected<", ">Proyección de negras<");
}
