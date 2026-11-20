# Las Cuatro Reconciliaciones: Lo que queda en las juntas después de reconstruir un motor de ajedrez en 36 horas

**Autor:** Angel Miranda (`angelmiranda.dev`) · **Agencia 8800**  
**Versión interactiva con ilustraciones procedurales en Canvas 2D:** [`docs/reconciliaciones-angelmiranda.html`](./reconciliaciones-angelmiranda.html)  
**Estudio de caso base:** [`docs/case-study-2026-11.md`](./case-study-2026-11.md)

---

## Resumen Ejecutivo

Entre el 18 y el 20 de noviembre de 2026, este motor y aplicación de análisis de ajedrez en Rust y TypeScript (100% local, WebAssembly, cero llamadas de red) atravesó una reconstrucción profunda: se eliminaron **157,518 líneas**, se escribió desde cero un motor de búsqueda **PVS** (`crates/search/src/engine.rs`) medido en **~3039 Elo en la escala CCRL Blitz** (IC 95%: 3007–3071) y se migró la vista principal de análisis (*Explore*) para correr sobre ese motor en el navegador a **1.0–1.5 millones de nodos por segundo**.

Pero cuando reemplazas el motor de un avión en pleno vuelo, la fricción nunca está en el motor nuevo: está en **las juntas con el fuselaje anterior**.

Al auditar el árbol tras la migración de *Explore* (`29c09ff` → `4bcee2a`), identificamos y ejecutamos **cuatro reconciliaciones estructurales**:

| Eje de Reconciliación | Metáfora Editorial (ELI5) | Evidencia Forense Medida |
|---|---|---|
| **I. Costos Hundidos** | *«El garaje de dos casas»* | **4,480 líneas** del motor/eval viejo (`lib.rs`) aún conviven con las **3,192 líneas** del motor nuevo; **24 scripts huérfanos** en `scripts/`; niveles 5 y 6 duplicados en `960,000` nodos (`play-wasm-executor.ts:95-96`). |
| **II. Errores Tragados** | *«El tablero con un solo foco rojo»* | **5 causas distintas** —incluyendo la cancelación normal del usuario (`play-worker-engine.ts:67`)— colapsaban en `"search-failed"`; `.unwrap_or(MoveQuality::Best)` (`wasm-bridge/src/lib.rs:1270`) y estado zombi en `new_game()` (`:500-506`). |
| **III. Foundations Rotas** | *«El velocímetro en la bicicleta vieja»* | El motor real corre a **2.0–3.0M nps** en nativo, pero `just bench` (`benches/baseline.json`) seguía midiendo el ejemplo viejo `m8_bench` a profundidad 3 (**239,982 nps**, 53,996 nodos). |
| **IV. Máquina de Estado Implícita** | *«El cruce sin semáforo»* | `PlayUiState` con **27 campos**, **67 mutaciones** `state = { ... }`, variable sombra `let playMode` (`:406`), **4 contadores manuales** y un bug real en `resignGame` (`play-ui.ts:638-640`) que olvidaba incrementar `forcingRequestVersion`. |

---

## Capítulo I. Costos Hundidos — *«El garaje de dos casas»*

### Versión ELI5 (Explicado con metáforas)
Imagina que tenías una casa vieja con tuberías ruidosas. En un fin de semana construyes al lado una casa nueva, luminosa y súper eficiente. Ya duermes y cocinas en la casa nueva (*Explore* y las partidas contra el rival ya usan el motor nuevo).

Pero como todavía guardas tres cajas de herramientas en el ático viejo (la revisión del *coach*, el mapa de reacción y la lente de jugadas forzadas), no has podido demoler la casa antigua. Peor aún: en el garaje tienes **24 cajas cerradas con cinta adhesiva** (scripts de verificación de diseños pasados) que nadie abre, y en el panel de velocidad de tu coche los botones de «Velocidad 5» y «Velocidad 6» estaban conectados exactamente al mismo cable (`960,000` nodos).

### Diagnóstico Técnico y Evidencia

1. **Dos pilas completas de búsqueda y evaluación en el mismo binario:**
   - **Motor Nuevo (`3,192` líneas totales):**
     - `crates/search/src/engine.rs` (`1,197` líneas) — PVS, TT, Null-Move, LMR, RFP/LMP, SEE en quiescence, MultiPV (`think_multi`).
     - `crates/search/src/explore.rs` (`309` líneas) — `side_explore` sobre 4 líneas reales de `think_multi`.
     - `crates/search/src/skill.rs` (`281` líneas) — niveles 1–6 sobre el motor real.
     - `crates/eval/src/tapered.rs` (`1,405` líneas) — evaluación *tapered* ajustada con Texel sobre millones de posiciones.
   - **Búsqueda y Evaluación Legadas (`4,480` líneas totales):**
     - `crates/search/src/lib.rs` (`3,378` líneas) — alimenta `search()` para `crates/coach`, `reaction_lines*` y `forcing_moves*`.
     - `crates/eval/src/lib.rs` (`1,102` líneas) — evaluación clásica sin ajuste Texel.

2. **Niveles 5 y 6 duplicados en `apps/web/src/play-wasm-executor.ts:82-97`:**
   ```ts
   const strengthDepthCaps: ReadonlyMap<number, number> = new Map([
     [1, 1], [2, 8], [3, 12], [4, 14],
     [5, 16],
     [6, 16] // ← Mismo tope de profundidad
   ]);
   const strengthNodeBudgets: ReadonlyMap<number, number> = new Map([
     [1, 60_000], [2, 120_000], [3, 240_000], [4, 480_000],
     [5, 960_000],
     [6, 960_000] // ← Mismo presupuesto de nodos que el nivel 5
   ]);
   ```
   **Reconciliación:** Se restablece una progresión estrictamente creciente entre los niveles 1 y 6 para que el selector de fuerza no tenga un escalón fantasma.

3. **Shim redundante en `crates/wasm-bridge/src/lib.rs:965-995`:**
   `best_move_user_context_json` recibía `_player_color: &str`, lo ignoraba por completo y delegaba a `best_move_context_json`.

4. **24 scripts huérfanos en `scripts/`:**
   De los 32 scripts en `scripts/`, solo 8 son invocados por `justfile` o `package.json`. Los 24 restantes (`proof-p1..p6`, `proof-m1..m10`, `measure-*`) quedaron de iteraciones previas de la interfaz.

---

## Capítulo II. Errores Tragados — *«El tablero con un solo foco rojo»*

### Versión ELI5 (Explicado con metáforas)
Imagina el tablero de instrumentos de un automóvil que solo tiene **un foco rojo gigante** que dice `FALLO DEL MOTOR`. Si se rompe una pieza interna, se prende el foco. Si el combustible está sucio, se prende el foco. ¡Pero si tú simplemente **cambias de opinión y giras el volante** (cancelando la búsqueda anterior porque hiciste otra jugada), también se prende el mismo foco rojo de `FALLO DEL MOTOR`!

Y en la fábrica de piezas (Rust), cuando el inspector no tenía a mano la regla para comparar qué tan buena era una jugada, en vez de anotar «Sin referencia», le pegaba una etiqueta dorada de **«¡Mejor Jugada (`Best`)!»** para salir del paso.

### Diagnóstico Técnico y Evidencia

1. **Cancelación normal reportada como `"search-failed"` (`apps/web/src/play-worker-engine.ts:62-70`):**
   ```ts
   cancel: () => {
     for (const [id, entry] of pending) {
       if (!entry.cancelable) {
         continue;
       }
       // Antes: entry.resolve({ ok: false, error: "search-failed" });
       // Después: discriminante explícito "cancelled"
       entry.resolve({ ok: false, error: "cancelled" });
       pending.delete(id);
     }
   }
   ```
   Cinco caminos distintos (JSON malformado, excepción en el runtime WASM, fallo de validación de esquema DTO, export ausente y la cancelación voluntaria por nueva jugada) terminaban en el mismo string `"search-failed"`. Separar `"cancelled"` evita que una operación normal del ciclo de vida de la UI dispare telemetría o estados de fallo del motor.

2. **Halago silencioso y referencia invertida en modo Aggressive (`crates/wasm-bridge/src/lib.rs:1251-1271`):**
   ```rust
   quality: move_quality_dto(
       best_exact_score
           .map(|best| classify_win_percent_loss(best, c.exact_score))
           .unwrap_or(MoveQuality::Best), // ← Mentira por omisión si best_exact_score es None
   ),
   ```
   Además de `.unwrap_or(MoveQuality::Best)`, `best_exact_score` se tomaba de `report.candidates.first()`. En modo `Aggressive` (donde las jugadas `sound` se reordenan por presión al rey; ej. tras `1.e4 e5` a 300k nodos `Bc4 +23` queda primera delante de `Nc3 +42`, `Nf3 +42` y `d4 +40`), `classify_win_percent_loss(23, 42)` daba pérdida `0.0` y **etiquetaba las 4 candidatas como `"best"`**.
   **Reconciliación:** Se toma `candidates.iter().map(|c| c.exact_score).max()` como referencia verdadera y se elimina `.unwrap_or(MoveQuality::Best)`, graduando `Bc4 (+23)` y `d4 (+40)` como `Excellent` y únicamente las de puntaje máximo (`+42`) como `Best`.

3. **Tablero zombi en `new_game()` (`crates/wasm-bridge/src/lib.rs:499-507`):**
   ```rust
   pub fn new_game() -> EngineStateDto {
       state_dto(&Position::startpos()).unwrap_or_else(|_error| EngineStateDto {
           fen: Position::startpos().to_fen(),
           status: GameStatusDto::Ongoing,
           draw_reason: None,
           side_to_move: ColorDto::White,
           legal_moves: Vec::new(), // ← Estado imposible: partida Ongoing con 0 jugadas legales
       })
   }
   ```
   **Reconciliación:** `Position::startpos()` es un invariante estático del dominio; ocultar un fallo devolviendo una partida "en curso" sin movimientos legales violaba la integridad del modelo.

---

## Capítulo III. Foundations Rotas — *«El velocímetro en la bicicleta vieja»*

### Versión ELI5 (Explicado con metáforas)
Imagina que entrenas un caballo pura sangre capaz de galopar a velocidad de campeonato (**~3039 Elo**, **2.5 millones de posiciones por segundo**). Cada vez que alguien te pregunta «¿qué tan rápido va el sistema hoy?», miras el velocímetro oficial del laboratorio (`just bench`)... ¡pero el cable del velocímetro sigue atornillado a la rueda de la bicicleta oxidada que usabas antes!

El velocímetro marca `239,982 nodos/s` a profundidad 3. Si el caballo nuevo duplica su velocidad o sufre una regresión, el velocímetro oficial no se mueve ni un milímetro porque sigue midiendo la bicicleta vieja.

### Diagnóstico Técnico y Evidencia

- En `benches/baseline.json` (generado el `2026-11-18`) y `benches/m8-bench.mjs`:
  ```json
  {
    "schema_version": 1,
    "generated_on": "2026-11-18",
    "command": "cargo run --release --quiet -p chess-search --example m8_bench",
    "position_set": ["startpos", "kiwipete", "recapture_trap", "stalemate_trap", "back_rank_mate"],
    "depth": 3,
    "total_nodes": 53996,
    "elapsed_ms": 225,
    "nodes_per_second": 239982
  }
  ```
- Tanto `m8_bench` como `crates/cli/src/main.rs` (`bench` y `analyze-fen`) invocaban `chess_search::search` (la búsqueda vieja de `crates/search/src/lib.rs`).
- **Reconciliación y Evidencia Medida (Antes vs Después):**
  1. **`just bench` (`cargo run --release --quiet -p chess-search --example m8_bench`, 5 posiciones):**
     - **Antes (`chess_search::search`, depth 3):** `53,996` nodos, `225 ms` en baseline (`239,982 nps`).
     - **Después (`Engine::think`, depth 9):** `194,109` nodos, `41 ms`, **`4,734,365 nps`** (**19.73× nps vs baseline**, llegando **6 plies más profundo en menos de la mitad del tiempo**).
  2. **`chess-cli bench --depth 6`:**
     - **Antes (`chess_search::search`, 3 posiciones):** `1,022,976` nodos, `1,886 ms` (`542,405 nps`).
     - **Después (`Engine::think`, 5 posiciones):** `24,401` nodos (**41.9× menos nodos**), `8 ms` (**235× más rápido en tiempo real**), **`3,050,125 nps`**.
  3. **`chess-cli analyze-fen` sobre Kiwipete (`--depth 6`):**
     - **Antes (`chess_search::search`):** `best_move="e2a6"`, `score_cp=-14`, `nodes=1,005,387`, `elapsed=1,817 ms`.
     - **Después (`Engine::think`):** `best_move="e2a6"`, `score_cp=3`, `nodes=7,065` (**142× menos nodos**), `elapsed=~3 ms`.

---

## Capítulo IV. Máquinas de Estado Implícitas — *«El cruce sin semáforo»*

### Versión ELI5 (Explicado con metáforas)
Imagina una cocina muy ocupada donde hay **cuatro libretas de números de pedido distintas**: una para el plato principal, otra para la guarnición, otra para las jugadas forzadas y otra para *Explore*. Cuando un cliente dice «¡Me rindo, cierren mi cuenta!» (`resignGame`), el mesero tiene que acordarse de tachar las cuatro libretas a mano.

En `play-ui.ts:638-640`, el mesero tachó la libreta 1 (`gameVersion`), la libreta 2 (`lensRequestVersion`) y la libreta 4 (`sideExploreRequestVersion`), **pero olvidó tachar la libreta 3 (`forcingRequestVersion`)**. Si había un pedido de jugadas forzadas cocinándose en segundo plano, al terminar entraba como Pedro por su casa y escribía resultados sobre una partida ya rendida.

### Diagnóstico Técnico y Evidencia

1. **Anatomía del estado implícito en `apps/web/src/play-ui.ts` (`6,014` líneas):**
   - `PlayUiState` (`:345-372`) agrupa **27 propiedades** en un solo registro plano.
   - Existen **67 asignaciones directas** `state = { ...state, ... }` distribuidas a lo largo del archivo.
   - Una variable mutable local `let playMode: PlayMode` (`:406`) duplicaba el campo `state.playMode` (`:357`), exigiendo sincronización manual en cada cambio de modo.
   - Cuatro contadores de versión independientes (`:394-397`) protegían contra condiciones de carrera de los Web Workers:
     ```ts
     let gameVersion = 0;
     let lensRequestVersion = 0;
     let forcingRequestVersion = 0;
     let sideExploreRequestVersion = 0;
     ```

2. **El bug real en `resignGame` (`apps/web/src/play-ui.ts:633-653`):**
   ```ts
   const resignGame = (actor: "user" | "rival"): void => {
     const currentState = state.engineState;
     if (!canResign(state) || currentState === null) {
       return;
     }
     gameVersion += 1;
     lensRequestVersion += 1;
     // ← BUG: Faltaba forcingRequestVersion += 1;
     sideExploreRequestVersion += 1;
     cancelActiveSearches();
     state = {
       ...state,
       lens: emptyLens(),
       reaction: emptyReaction(),
       // ← BUG: Faltaba forcing: emptyForcing(),
       sideExplore: emptySideExplore(),
       ...
     };
   };
   ```

3. **Reconciliación Estructural (`apps/web/src/play-state-machine.ts`):**
   - Se introduce `createRequestTracker()` con métodos atómicos (`invalidateAll()`, `invalidatePosition()`, `nextGame()`, `nextLens()`, `nextForcing()`, `nextSideExplore()`, `isCurrent(...)`).
   - Se elimina la variable sombra `let playMode`, dejando a `state.playMode` como única fuente de verdad.
   - Se extraen transiciones puras y deterministas cubiertas por pruebas unitarias en `apps/web/src/play-state-machine.test.ts`.

---

## Verificación y Auditorías Locales

Esta pieza editorial y su contraparte interactiva [`docs/reconciliaciones-angelmiranda.html`](./reconciliaciones-angelmiranda.html) cumplen todas las invariantes del repositorio:

- **100% Local y Autocontenida:** Cero CDNs, cero fuentes remotas, cero llamadas de red.
- **Ilustraciones Procedurales en Vivo:** 4 escenas dibujadas trazo a trazo en Canvas 2D con simulación multi-cerda, presión por curvas de Bézier, textura de papel algodón en offscreen canvas y lavados de acuarela *wet-on-wet*.
- **Comandos de verificación:**
  ```sh
  node scripts/audit-runtime-network.mjs
  node scripts/audit-policy.mjs
  ```
