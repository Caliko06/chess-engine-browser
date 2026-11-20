# Play game archives

Flujo normal (ADR-0241, cero exports manuales): con `just preview` corriendo, cada Save Game /
New Game y cada terminal de partida persisten la partida automaticamente como `live-YYYY-MM-DD.jsonl`
en este directorio. El guardado terminal es raw-only: no ejecuta el analyzer ni Stockfish.
Fallback: los downloads `play-game-archive*.jsonl` de `~/Downloads` se importan solos al correr
`just play-memory` (dedup por hash de contenido, como `imported-<hash>.jsonl`). Tambien puedes
depositar exports a mano (`YYYY-MM-DD-games.json`).

Estos archivos son READ-ONLY para los ejecutores: nunca se editan a mano. Los reportes del
analyzer se escriben al lado como `<nombre>.analysis.json`.

El analyzer es bajo demanda. `just analyze <game-id>` lee el archive raw y persiste por defecto
`data/play-archive/<game-id>.analysis.json`; imprime la misma tabla CLI y no analiza nada al
terminar una partida. Para un PGN por stdin, el report sigue siendo temporal salvo que se indique
una salida explícita con `--output <path>`.

## Uso normal (un solo comando)

```text
just play-memory
```

Eso analiza los exports nuevos/cambiados con el oraculo Stockfish local (resolucion automatica:
`CHESS_PLAY_STOCKFISH_BIN`, luego `/opt/homebrew/bin/stockfish`, luego `which stockfish`),
recompila `data/engine-memory/refutations.v1.json`, regenera `known-gaps.v1.json` y verifica el
harness. Resumen en `data/engine-memory/last-update-report.json`.

Para dejarlo corriendo y que procese cada export nuevo automaticamente:

```text
just play-memory-watch
```

## Pasos manuales equivalentes

Detalle en ADR-0239 y ADR-0240 (tag git `governance-archive`):

1. `node scripts/play-game-archive-analyze.mjs --input data/play-archive/<archivo>.json --output data/play-archive/<archivo>.analysis.json --depth 12`
   (requiere `CHESS_PLAY_STOCKFISH_BIN` para el oraculo)
2. Compilar memoria:
   `node scripts/play-evidence-compile-memory.mjs --reports data/play-archive/<archivo>.analysis.json --output data/engine-memory/refutations.v1.json`
3. Regenerar known gaps:
   `CHESS_EVIDENCE_REGENERATE=1 cargo nextest run -p chess-search --test evidence_refutation_memory`

Las partidas en cuarentena nunca entran a la memoria del motor.
