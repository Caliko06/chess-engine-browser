# Claude Code en Chess

El contexto del repo está en [`AGENTS.md`](AGENTS.md): qué quiero obtener, dónde está cada cosa y
qué sabemos. Empieza por ahí.

## Modelos disponibles

| Quién | Modelo y esfuerzo | Dónde se configura |
|---|---|---|
| Hilo principal | Opus 5.5, `high` | `.claude/settings.json` |
| Subagente por defecto | Sonnet 5.5, `medium` | `CLAUDE_CODE_SUBAGENT_MODEL` en el mismo archivo |

## Qué busco al delegar

Quiero el mejor resultado al menor costo y latencia. Tú decides a quién darle cada trabajo; estas
son las referencias que me han funcionado:

| Tipo de trabajo | Suele bastar |
|---|---|
| Búsquedas, inventarios, ediciones mecánicas, correr checks, aplicar un plan ya escrito | Sonnet `medium` |
| Bien acotado pero con varios pasos delicados (p. ej. depurar un E2E que falla) | Sonnet con más esfuerzo |
| Diseño entre módulos, corrección de búsqueda o evaluación, rendimiento que hay que probar con bench | Opus `high` |
| Consultas triviales de solo lectura | Haiku `low` |

Me ayuda ver la elección en una línea (`agente: <modelo>/<esfuerzo>, <por qué>`), y que el hilo
principal integre lo que regresa y compruebe el resultado antes de darlo por hecho.
