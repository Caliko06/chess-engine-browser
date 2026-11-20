# Chess: mapa de contexto

Esto no es un reglamento. Es lo que quiero obtener y dónde está cada cosa. Usa tu criterio; si algo
de aquí choca con lo que ves en el código, confía en el código y dímelo.

## Qué quiero obtener
- Un motor de ajedrez propio, rápido y fuerte, que corre completo en mi máquina y en el navegador.
- Que `Explore` me diga qué jugar ahora para que **mi** lado gane, con el tablero primero y una
  explicación honesta de qué tan seguro está (profundidad, presupuesto, riesgo).
- Código simple: arreglar la causa antes de agregar capas, borrar lo que sobra.
- Evidencia en vez de afirmaciones: cuando digas "más rápido" o "más fuerte", muéstrame el número
  y el comando. Velocidad, exactitud y fuerza son cosas distintas.
- Pruebas que demuestren que algo funciona como yo lo uso: prefiero E2E que dejen un artefacto
  repetible. Si pruebas algo aislado, piensa antes en cómo puede fallar.

## Lo que quiero cuidar
- Que siga siendo local: sin red en binarios, frontend ni `build.rs` (`just audit-runtime-network`).
- Dependencias nuevas, persistencia o API pública: pregúntame antes, prefiero decidirlo yo.
- Stockfish sirve para validar en local, no como pieza del producto.
- NNUE descartado para siempre (OWNER 2026-11-18); la evaluación es solo Classical.

## Mapa del código
```text
board -> eval (tapered | clásica) -> search (engine.rs: motor -> explore.rs: Explore | lib.rs: lentes viejas)
      -> wasm-bridge -> worker del navegador -> UI
```

| Dónde | Qué hay |
|---|---|
| `crates/board` | Posición, FEN, jugadas legales. Rápido: perft 5 en 0.14 s (~35 M nodos/s). |
| `crates/search/src/engine.rs` | **Motor**: PVS, TT, LMR, null-move, SEE; MultiPV en `think_multi` (`:261`). ~3039 CCRL Blitz (2948-3083 según ancla, banco en `~/chess-elo`). |
| `crates/search/src/explore.rs` | **Explore** (`side_explore` `:152`): 4 candidatas de `think_multi`. Aggressive solo reordena las que están a ≤50 cp de la mejor, por ataque al rey. La jugada de la partida sale de aquí. |
| `crates/search/src/skill.rs` | Niveles 1-6 sobre `engine.rs` (6 = motor completo). |
| `crates/search/src/lib.rs` | Búsqueda vieja (3.4 k líneas, no usa `engine.rs`): `search` (`:177`, revisión del coach), `reaction_lines*` (mapa de reacción), `forcing_moves*` (lente de forzadas). |
| `crates/eval/src/tapered.rs` | Eval afinada con Texel; la usan `engine.rs` y Explore. |
| `crates/eval/src/lib.rs` | Eval clásica sin afinar (`evaluate` `:153`); la usa la búsqueda vieja de `lib.rs`. |
| `crates/wasm-bridge` | DTOs y JSON al navegador. Jugada propia `engine_best_move` `:1027`; rival `PLAY_ENGINE` `:897`. Presupuestos por defecto 60 k (`:37`, `:610`); la web manda los suyos. |
| `crates/cli` | `perft`, `bench` (mide la búsqueda vieja de `lib.rs`), `side-explore` (Explore), `uci` (motor), `datagen`. |
| `crates/tuner` | Ajuste Texel de `tapered.rs`. |
| `crates/coach` | Revisión de partidas (usado por cli y wasm-bridge). |
| `apps/web/src/play-ui.ts` | Toda la UI de juego (6 k líneas); estado en `PlayUiState` (`:344`). Presupuestos de Explore: 100 k rápido, 300 k profundo (`play-wasm-executor.ts:97`). |
| `apps/web/src/play-worker-engine.ts` | Workers del motor; cancelar recrea el worker de análisis (`:82`). |
| `data/engine-memory` | Memoria de refutaciones que se compila al frontend. |

## Lo que ya sabemos (auditoría 2026-11-19, e823ecb; Explore migrado 2026-11-20, 29c09ff)
- **Explore usa el motor.** En WASM el motor hace 1.0-1.5 M nodos/s: con 300 k nodos Explore llega a
  prof. 9-10 en ~200 ms y respeta el presupuesto exacto (antes prof. 1-5, 220-290 k nodos/s, y se
  pasaba). 1.e4 e5 con Aggressive: antes Dh5 +70, ahora d4 +52.
- **Siguen en la búsqueda vieja:** revisión del coach, mapa de reacción y lente de forzadas.
- **Niveles 1-6 de la jugada propia** (`best_move*`): ahora solo cambian el presupuesto de nodos.
- **Velocidad nativa:** motor 2.0-3.0 M nodos/s (`uci`, 60 k nodos); 1.85x sobre v8 en el banco.
  `just bench` y `chess-cli bench` miden la búsqueda vieja, no el motor.
  `benches/baseline.json` es del 2026-11-18, prof. 3.
- **Errores que se pierden:** casi todo termina como `"search-failed"` (9 archivos de `apps/web/src`);
  cancelar también (`play-worker-engine.ts:67`); sin referencia, una jugada de Explore sale como
  "Best" (`wasm-bridge/src/lib.rs:1266`).
- **Estados implícitos en la UI** (revisión 2026-11-18, no re-verificado): 4 sub-estados de
  análisis, 5 contadores de versión para descartar respuestas viejas y ~60 reasignaciones de
  `state` sin transiciones declaradas.
- `just check` y `just test` pasan en 29c09ff (390 pruebas de Rust más las web).
  `audit-policy` rechaza la palabra "Stockfish" en código de producción.
- ~25 scripts `scripts/proof-*` y `measure-*` no los llama `justfile` ni `package.json`.
- Node 26 instalado; `package.json` pide 22 o 24 (solo aviso).

## Comandos
```text
just preview   # la app local
just check     # fmt, clippy, deny, auditorías, typecheck, lint
just test      # Rust + web
just bench     # velocidad de la búsqueda de Explore contra benches/baseline.json
just oracle    # comparación local con Stockfish
```

## Historial
Las decisiones, handoffs y auditorías anteriores están en el tag git `governance-archive`
(`git show governance-archive:docs/adr/`). Sirven como contexto si lo necesitas, no mandan.
