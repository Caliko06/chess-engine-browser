import type { ColorDto } from "./engine-dtos.js";
import { createPlayWasmExecutor } from "./play-wasm-executor.js";
import type {
  PlayBestMoveContext,
  PlayEngine,
  PlayEngineResult,
  PlaySideExploreContext,
  PlayWasmModule
} from "./play-wasm-executor.js";

type WorkerRequest =
  | { readonly id: number; readonly op: "newGame" }
  | { readonly id: number; readonly op: "makeMove"; readonly fen: string; readonly mv: string }
  | {
      readonly id: number;
      readonly op: "bestMove";
      readonly fen: string;
      readonly depth: number;
      readonly legalMoves: readonly string[] | undefined;
      readonly aggressive: boolean;
      readonly context?: PlayBestMoveContext | undefined;
    }
  | {
      readonly id: number;
      readonly op: "reactionMap";
      readonly fen: string;
      readonly depth: number;
      readonly deep: boolean;
    }
  | {
      readonly id: number;
      readonly op: "forcingMap";
      readonly fen: string;
      readonly depth: number;
      readonly host: ColorDto;
      readonly deep: boolean;
    }
  | {
      readonly id: number;
      readonly op: "sideExplore";
      readonly fen: string;
      readonly side: ColorDto;
      readonly aggressive: boolean;
      readonly historyFens: readonly string[];
      readonly context?: PlaySideExploreContext | undefined;
    };

type WorkerResponse = { readonly id: number; readonly result: PlayEngineResult<unknown> };

type WorkerScope = {
  readonly addEventListener: (
    type: "message",
    listener: (event: MessageEvent<WorkerRequest>) => void
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

scope.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  void dispatch(event.data);
});

async function dispatch(request: WorkerRequest): Promise<void> {
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
      case "bestMove":
        result = await engine.bestMove(
          request.fen,
          request.depth,
          request.legalMoves,
          request.aggressive,
          request.context
        );
        break;
      case "reactionMap":
        result = engine.reactionMap
          ? await engine.reactionMap(request.fen, request.depth, request.deep)
          : { ok: false, error: "search-failed" };
        break;
      case "forcingMap":
        result = engine.forcingMap
          ? await engine.forcingMap(request.fen, request.depth, request.host, request.deep)
          : { ok: false, error: "search-failed" };
        break;
      case "sideExplore":
        result = engine.sideExplore
          ? await engine.sideExplore(
              request.fen,
              request.side,
              request.aggressive,
              request.historyFens,
              request.context
            )
          : { ok: false, error: "search-failed" };
        break;
    }
  } catch {
    result = { ok: false, error: "search-failed" };
  }
  scope.postMessage({ id, result });
}
