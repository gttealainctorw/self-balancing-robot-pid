# Implementation and test report: web redesign, digital twin, Xbox controller

Date: 2026-11-14. Firmware version 2.0.0. Companion documents: `PROJECT_AUDIT.md`, `DESIGN_AND_TECH_RESEARCH.md`, `ROBOT_WEB_IMPLEMENTATION_PROMPT.md`.

## 1. What changed

- The single embedded page was replaced by a two-page web app served from the robot: **Control** (`/control`) and **Statistics** (`/statistics`).
- A **digital twin** built from the real deck CAD is shared by both pages.
- The firmware gained **50 Hz batched telemetry**, a **read-only telemetry endpoint**, a **drive lock with ownership**, an **E-STOP command**, gzip asset serving and an on-robot web self-test.
- **Xbox controller** support through the browser Gamepad API, using the same command path as the joystick.
- A **development server** with a simulated robot, which is also the localhost bridge to the real one.
- Everything the old page did (live tuning, save/reload, auto-tune, calibration, motor tests, log) is in *Control → Setup* and sends the same commands.

## 2. Files

**Created**

| Path | Purpose |
|---|---|
| `web/index.html`, `web/app.css` | Document for both routes; design system and layouts |
| `web/js/00-lib.js` | Pure logic: dead zone, drive shaping, sample decoding, session statistics, CSV, ticks, leader-line layout |
| `web/js/10-core.js` | Telemetry store, link to the robot, settings, toasts |
| `web/js/20-twin.js` | WebGL2 renderer and 2D fallback of the digital twin |
| `web/js/30-chart.js` | Strip charts |
| `web/js/40-gamepad.js` | Gamepad API input and controller drawing |
| `web/js/50-control.js`, `60-stats.js`, `90-main.js` | The two pages and start-up |
| `web/test/lib.test.js` | 8 unit tests |
| `web/fonts/` | Geist and Geist Mono subsets, OFL licence |
| `web/model/cad/` | The three STL decks and their notice |
| `web/model/robot.bin` | Generated twin mesh |
| `tools/build_twin.py`, `tools/build_web.py`, `tools/dev_server.py` | Mesh builder, asset packer, simulated robot / bridge |
| `firmware/balance_robot/web_assets.h` | Generated: the app as gzip blobs |
| `docs/*.md`, `docs/img/*.jpg` | Audit, research, implementation prompt, this report, screenshots |

**Modified:** `firmware/balance_robot/balance_robot.ino`, `firmware/balance_robot/config.h`, `README.md`, `.gitignore`.
**Removed:** `firmware/balance_robot/web_page.h` (replaced by `web_assets.h`).
**Not touched:** the control law (`runStep`), `matlab/`, the classic-Nano behaviour apart from a new `estop` command.

## 3. Repositories investigated and what was selected

The full tables, with license and last-push date for each of the 40 repositories read from the GitHub API, are in `DESIGN_AND_TECH_RESEARCH.md`. Summary of the decisions:

| Concern | Considered | Selected | Reason |
|---|---|---|---|
| 3D | three.js (171 kB gzip), Babylon.js (1.29 MB), model-viewer, twgl.js, glTF + Draco/meshopt | Custom WebGL2 renderer + own binary mesh | The model has 10 168 triangles; the whole twin (code + mesh) is about 28 kB from the robot's flash |
| Charts | uPlot (22 kB), Chart.js (69 kB), ECharts (333 kB), Plotly (1.33 MB), smoothie | Custom canvas strip charts | Draws straight from the telemetry rings; uPlot is the documented upgrade path |
| Transport | arduinoWebSockets, ESPAsyncWebServer, SSE | HTTP polling with batched samples | No external firmware library; works for any number of devices |
| UI kit | shadcn/ui, Radix, Tailwind, Tabler, Tremor | Hand-written CSS | No framework in the project; patterns studied, no code copied |
| Liquid glass | liquid-glass-react, shuding/liquid-glass, liquid-glass-effect-macos | Plain CSS glass | SVG-filter refraction is Chromium-only; phones need Safari and Firefox |
| Joystick, gamepad | nipplejs, gamecontroller.js | Pointer events + Gamepad API directly | Under 100 lines each, with arm/link awareness |
| Fonts | Geist, Inter | Geist + Geist Mono, Latin subsets | 47 kB, self-hosted, tabular figures |

No runtime dependency was added. Build tools use the Python standard library only.

## 4. How the digital twin was generated

1. `models/base-deck.stl`, `mid-deck.stl` and `upper-deck.stl` were taken from the reference repository's `models/` folder (the only folder inspected). Together they have 7 128 triangles.
2. Their features were measured from the meshes: 150 × 100 mm plates, posts at (±63, ±38) mm, motor slots on the centre line at both ends with bracket tabs at ±54 mm, four L298N bosses at (±19, ±19), two controller bosses at (0, ±21), and a stepped window with two M2 bosses for the MPU6050.
3. `tools/build_twin.py` stacks the decks on their own post shoulders (mid deck 48 mm and top deck 101 mm above the base underside), welds and quantizes vertices to 0.01 mm, and adds parametric stand-ins on those features: two vertical TT gear motors, two 65 mm wheels with five spokes, the L298N, the Nano terminal adapter with the Nano ESP32, and the MPU6050.
4. It extracts feature edges (dihedral angle over 28°) for the line overlay and writes `robot.bin`: 5 138 vertices, 10 168 triangles, 4 910 edge segments, 115 kB raw and 24 kB gzip after delta coding.
5. `20-twin.js` renders it with one WebGL2 program: flat normals from screen-space derivatives, key/fill/rim lighting, per-part glow, a dotted floor with a contact shadow. Three nodes move: body (pitch about the axle, roll about the ground line) and each wheel.

Fidelity statement: the deck geometry is the CAD. Motors, wheels and boards are stand-ins sized from catalogue dimensions; the vertical position of the wheel axle and the wheel track are estimates from the mounting geometry. No battery is drawn because its position is not in the CAD.

## 5. How the two-page architecture works

- One HTML document is served at `/control` and `/statistics`; the script reads the path, removes the other page's markup and starts that page only. The robot stores no page state, so devices are independent.
- The control task writes a sample every 20 ms into a 128-entry ring. `/t?s=<seq>` (read-only) and `/j?...` (drive + telemetry) return every sample since the caller's sequence number, plus state and new status messages.
- The Statistics page uses `/t` and `/s` only. The Control page uses `/j` as its heartbeat and `/c` for commands.
- Driving is honoured only for the client id that armed it (see README, "Driving safety").

## 6. How the Xbox controller integration works

`Controller → operating system → browser Gamepad API → Control page → /j → robot`. The page polls `navigator.getGamepads()`, prefers a pad with the standard mapping, applies a radial dead zone and the speed limit (RT raises it, LT lowers the command), and turns button edges into the same functions the on-screen buttons call. Disconnecting the pad, hiding the page or losing focus sends neutral and locks driving; reconnecting never re-arms. Buttons can be reassigned by pressing them.

## 7. Tests that passed

**Automated**

| Test | Result |
|---|---|
| `node --test web/test/lib.test.js` | 8 of 8 pass |
| `arduino-cli compile`, `esp32:esp32:nano_nora`, all warnings | No warnings in the sketch; 1 128 kB (35 % of flash) |
| `arduino-cli compile`, `arduino:avr:nano`, all warnings | No warnings in the sketch; 27 904 bytes (90 %), RAM 68 % |

**On the real Nano ESP32 (USB serial, firmware 2.0.0 flashed)**

| Test | Result |
|---|---|
| Boot | MPU6050 found, gyro calibrated, access point `BalanceBot-7C78` running |
| `webtest` | All 9 resources returned `200` with the exact expected byte counts, gzip where expected, in 8–23 ms each |
| `webtest dump` | `/t` returned valid JSON: 32 samples, 10 fields each, exactly 20 ms apart, with the real pitch (−26.9°, robot lying down) and roll; `/s` returned valid JSON with 16 parameters |
| `d 0.5 0` while locked | Refused: "Driving is locked: send 'arm' first" |
| `on`, `arm`, `info` | "Drive armed", `drive=armed` |
| No command for 2 s | "Drive locked: control link lost", `drive=locked` |
| `estop`, then `arm` | Balancing off, drive locked; arming refused |

**In a browser (Chromium 156) against the simulated robot**

| Test | Result |
|---|---|
| A. Old functions | Parameter slider reaches the robot (`kp` 45 → 52 confirmed through `/s`). Clicking every Setup button sent exactly `save`, `load`, `reset`, `calg`, `mt`, `invl`, `ramp`, `ok`, `stop`, `autotune`, `autotune stop`; Balance sent `off`; E-STOP sent `estop` and left balancing off and driving locked |
| B. Two pages | `/control` and `/statistics` load from the same server. While the Statistics page was open, a second client armed and drove: the page showed its data and issued only `/t`, `/s` and asset requests (31 `/t`, 1 `/s`, 0 `/j`, 0 `/c`) |
| B. Ownership | A foreign client sending `/j?v=-1` while another client drove forward had no effect |
| B. Link loss | Owner silent for 2.6 s → drive locked; on return its `/j` commands were ignored until it armed again |
| C. Twin | WebGL2 mode; pitch in the twin follows telemetry; a drag changed azimuth and elevation and a double-click restored the view; same component on both pages |
| D. Statistics | Charts update; recording of 3.2 s gave 163 samples, a summary and a CSV with 163 data lines; no pre-filled data |
| D. Missing data | With the server stopped, after 5 s: link pill "No link", every read-out "—", banner "No link to the robot", twin dimmed, drive command 0 |
| D. Annotations | 6 leader lines, 0 crossings (computed from the rendered paths at 1440 × 900) |
| E. Controller, **simulated pad** | Detection; stick ignored while locked; A arms; 8 % deflection inside the dead zone gives 0; full stick gives 0.447 forward at the 50 % limit; RT → 0.894; LT → 0.157; release → 0; disconnect → neutral and locked; reconnecting with the stick held stays locked; B → E-STOP; Menu → balance on |
| F. Layout | No horizontal overflow at 360 × 740, 740 × 360, 820 × 1180, 1100 × 760 and 1440 × 900 (document width equals window width); the landscape phone layout fits on one screen as in the sketch. Two problems found by looking at screenshots were fixed: the header overflowed on narrow phones, and the twin was cropped on tall, narrow stages |
| Navigation lock | Locks the nav links, blocks a click on them, unlocks after a 0.8 s hold |
| Non-localhost origin | The app runs from `http://<LAN address>:8080` (`isSecureContext` false); `navigator.getGamepads()` is callable there |

## 8. Tests that could not be performed

- **The app in a browser against the real robot.** This computer was not joined to the robot's WiFi (that would have dropped its own network), so the pages were exercised against the simulated robot, and the real robot's serving and API were verified from the robot itself (`webtest`) and over serial. Opening `http://192.168.4.1/control` from a phone is still to be done.
- **A physical Xbox controller.** None was available. Controller logic was tested with a simulated standard-mapping gamepad injected into the page. Bluetooth/USB pairing, real axis noise and whether Chromium reports a pad on `http://192.168.4.1` are untested.
- **Two physical devices at once.** Tested as one browser page plus a second HTTP client on the simulated robot, not with two phones on the real one.
- **Driving the real robot from the app.** The robot was lying down on the bench; the balancing fix in pull request #4 has not yet been confirmed on the floor.
- **Battery sensing.** The optional code path compiles but no divider is wired.
- **Safari and Firefox.** Only Chromium was available. The CSS avoids Chromium-only features, and the WebGL2 and Gamepad fallbacks exist, but they were not run in those browsers.
- **Throughput with two real clients on the ESP32's synchronous server** (about 22 requests per second in total).

## 9. Hardware limits and remaining requirements

- No encoders: wheel motion and speed are estimates and are labelled so.
- No battery measurement until a divider is wired and `BATTERY_SENSE` is set.
- E-STOP is software. A physical switch on the battery lead remains the emergency stop.
- The Gamepad API may be hidden on `http://192.168.4.1` depending on the browser; the localhost bridge covers that case on a computer.
- The classic Nano is at 90 % of flash; the web features exist only on the Nano ESP32.

## 10. Deviations from the implementation prompt

- There is no `web/dist` folder: the dev server builds the assets in memory.
- Leader lines are assigned by trying every order per side and keeping the one with no crossings and the shortest length, instead of sorting by height (sorting alone can cross).
- The drive command is computed right before every poll as well as on every animation frame, so it never depends on the page being drawn.
- The twin widens its field of view on tall, narrow stages so the robot always fits.
- `webtest` runs its client in a separate task over `127.0.0.1`. A first version in the same task as the server stalled on files above about 10 kB, which was an artefact of the test, not of serving.

## 11. How to run

- **On the robot:** upload `firmware/balance_robot/balance_robot.ino` (no tools needed), join `BalanceBot-XXXX`, open `http://192.168.4.1/control` and, on another device, `http://192.168.4.1/statistics`.
- **Without the robot:** `python tools/dev_server.py`, then `http://localhost:8080/control`.
- **Bridge for controllers:** `python tools/dev_server.py --robot http://192.168.4.1`.
- **After editing `web/`:** `python tools/build_web.py`, then upload the sketch.

## 12. Second pass (firmware 2.1.0, 2026-11-15)

**Added**

- Cover page at `/` using the supplied artwork unmodified, with link areas over its navigation and buttons, and two short text sections below it.
- Statistics: the charts are now one stacked panel with a shared time axis and cursor, pause/pan/zoom, limit lines and gaps where data is missing. A **PID terms** row shows P, I, D and the output.
- Firmware: the three PID terms are sent with every sample; `fig heart`, `fig inf`, `fig stop` drive a figure by gyro heading; `/` serves the app.
- Control: Heart / Infinity buttons, camera presets for the twin, and a prompt explaining how to arm when the joystick or the controller is used while locked.
- Twin: reflection in the floor, studio reflection on metal parts, tyre tread, hub nuts and deck screws (11 656 triangles, 26 kB gzip).
- Typography and visual language replaced (see `DESIGN_AND_TECH_RESEARCH.md`, section H).

**Tested**

| Test | Result |
|---|---|
| Unit tests | 8 of 8 |
| Compile, both boards | Nano ESP32 1 269 kB (40 %); classic Nano 27 904 bytes (90 %, unchanged) |
| Cover in Chromium | Image shown at its exact aspect ratio; its 12 link areas point to the intended pages; the cover makes no request to the robot API |
| Shared cursor | Hovering one chart sets the cursor time for all and updates every legend |
| Pause, pan, zoom | Pause freezes the view while samples keep buffering; panning moved the view by the requested 3 s; wheel changed the window 30 → 24 s; double-click returned to live |
| PID terms | Present in the simulated telemetry and drawn; the response to a disturbance is visible in P, D and output |
| Figures, **simulated robot** | Heart: refused while locked with a prompt; ran when armed, showing progress; the path integrated from the simulated yaw rate and speed estimate is a recognisable heart, closing to within 0.07 of its 0.6 extent |
| Layout | No horizontal overflow where measured: cover at 1280 × 720 and 390 × 780, Control at 390 × 780 and 780 × 390 (everything on one screen), Statistics at 390 × 780. No console errors on any page |

**On the real Nano ESP32 (firmware 2.1.0 flashed, USB serial)**

| Test | Result |
|---|---|
| `webtest` | All 10 resources returned `200` with the exact byte counts, including the 132 900-byte cover image |
| `webtest dump` | `/t` is valid JSON with 13 fields per sample (the three PID terms included), 20 ms apart, plus `fig` and `fp`; `/s` reports firmware 2.1.0 |
| `fig heart` while locked | Refused: "Cannot start: the robot must be balancing and driving armed by you" |
| Saved parameters | Kept across the update (motor inversion and gains unchanged) |

**Not tested**

- The app in a browser against the real robot, as in the first pass.
- The figures on a real floor. Their size and closure depend on the surface and the motors, and the heading gains (`FIG_TURN_GAIN`, `FIG_DRIVE` in `config.h`) may need adjusting.
- The infinity figure was implemented with the same code path as the heart but only the heart was run in the simulator.
- Safari and Firefox.

**Note on the cover artwork.** The image was supplied by the project owner. Its composition closely follows a published third-party web design; if the repository stays public, check that the artwork may be redistributed.
