import { generatedPlayRefutationMemoryCases } from "./generated/play-refutation-memory.generated.js";

export type PlayRefutationMemoryCase = {
  readonly positionKey: string;
  readonly move: string;
  readonly advice: string;
};

export const playRefutationMemoryCases: readonly PlayRefutationMemoryCase[] = generatedPlayRefutationMemoryCases;

export function positionKeyFromFen(fen: string): string {
  return fen.trim().split(/\s+/u).slice(0, 4).join(" ");
}

export function refutationMemoryHit(
  fen: string,
  move: string,
  cases: readonly PlayRefutationMemoryCase[] = playRefutationMemoryCases
): PlayRefutationMemoryCase | null {
  const positionKey = positionKeyFromFen(fen);
  return cases.find((entry) => entry.positionKey === positionKey && entry.move === move) ?? null;
}
