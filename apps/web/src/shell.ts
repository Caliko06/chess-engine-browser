import type { EngineStateDto, GameStatusDto } from "./engine-dtos.js";

export type ShellCommandId = "new-game" | "make-move" | "best-move" | "analyze" | "review-pgn";

export type ShellViewModel = {
  readonly title: string;
  readonly commands: readonly ShellCommandId[];
  readonly state: EngineStateDto;
};

export const startFen =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export function createInitialShell(status: GameStatusDto = "ongoing"): ShellViewModel {
  return {
    title: "Chess",
    commands: ["new-game", "make-move", "best-move", "analyze", "review-pgn"],
    state: {
      fen: startFen,
      status,
      sideToMove: "white",
      legalMoves: []
    }
  };
}
