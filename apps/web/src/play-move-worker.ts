import { createPlayWasmExecutor } from "./play-wasm-executor.js";
import type {
  PlayBestMoveContext,
  PlayEngine,
  PlayEngineResult,
  PlayWasmModule
} from "./play-wasm-executor.js";

type MoveRequest =
  | { readonly id: number; readonly op: "newGame" }
  | { readonly id: number; readonly op: "makeMove"; readonly fen: string; readonly mv: string }
  | { readonly id: number; readonly op: "loadPosition"; readonly fen: string }
  | {
      readonly id: number;
      readonly op: "bestMove";
      readonly fen: string;
      readonly depth: number;
      readonly legalMoves: readonly string[] | undefined;
      readonly aggressive: boolean;
      readonly context?: PlayBestMoveContext | undefined;
    };

type WorkerResponse = { readonly id: number; readonly result: PlayEngineResult<unknown> };

type WorkerScope = {
  readonly addEventListener: (
    type: "message",
    listener: (event: MessageEvent<MoveRequest>) => void
  ) => void;
  readonly postMessage: (message: WorkerResponse) => void;
};

const scope = self as unknown as WorkerScope;

function dynamicImport(specifier: string): Promise<unknown> {
  return import(specifier);
}

const wasmSpecifier = "./pkg/chess_wasm_bridge_embedded.mjs";

function loadModule(): Promise<PlayWasmModule> {
  return dynamicImport(wasmSpecifier) as Promise<PlayWasmModule>;
}

const engine: PlayEngine = createPlayWasmExecutor(loadModule);

// Eagerly load the WASM module to reduce first-use latency.
void engine.newGame();

scope.addEventListener("message", (event: MessageEvent<MoveRequest>) => {
  void dispatch(event.data);
});

async function dispatch(request: MoveRequest): Promise<void> {
  const { id } = request;
  let result: PlayEngineResult<unknown>;
  try {
    switch (request.op) {
      case "newGame":
        result = await engine.newGame();
        break;
      case "makeMove":
        result = await engine.makeMove(request.fen, request.mv);
        break;
      case "loadPosition":
        result = engine.loadPosition
          ? await engine.loadPosition(request.fen)
          : { ok: false, error: "search-failed" };
        break;
      case "bestMove":
        result = await engine.bestMove(
          request.fen,
          request.depth,
          request.legalMoves,
          request.aggressive,
          request.context
        );
        break;
    }
  } catch (caught) {
    result = {
      ok: false,
      error: "search-failed",
      detail: caught instanceof Error ? caught.message : String(caught)
    };
  }
  scope.postMessage({ id, result });
}
