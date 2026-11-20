# Play evidence engine memory

Archivos:

- `refutations.v1.json`: memoria compilada. Schema: `{ schema: 1, cases: [...] }`.
- `known-gaps.v1.json`: inventario generado por el harness Rust cuando el motor todavia
  promueve como top sound una jugada refutada.

- `last-update-report.json`: resumen no trackeado del ultimo `just play-memory` (ADR-0240), con
  `playerProfile.patterns` para patrones amplios y `playerProfile.signals` para señales exactas;
  es consultivo y no aprueba entrenamiento ni modifica el motor por si solo.

No edites estos archivos a mano. El ciclo completo es `just play-memory` (o
`just play-memory-watch` para dejarlo corriendo). Equivalente manual:

```text
node scripts/play-evidence-compile-memory.mjs --reports data/play-archive/*.analysis.json --output data/engine-memory/refutations.v1.json
CHESS_EVIDENCE_REGENERATE=1 cargo nextest run -p chess-search --test evidence_refutation_memory
```

Reglas de inclusion resumidas en ADR-0239:

- `refuted-recommendation`: `oracle-move-delta` fail con `deltaCp <= -150`, depth >= 12, y
  `shallow-recommendation-failure` en el mismo ply.
- `refuted-played`: fail de oraculo sin snapshot de recomendacion; entra con ocurrencias >= 2 o
  una sola ocurrencia con `deltaCp <= -400`.
- Solo contribuyen partidas aceptadas por el analyzer; partidas en cuarentena nunca entran.
