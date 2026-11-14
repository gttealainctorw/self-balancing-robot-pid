# Implementation prompt: BalanceBot web interface, digital twin and controller

Project-specific specification derived from `PROJECT_AUDIT.md` and `DESIGN_AND_TECH_RESEARCH.md`. It is the contract for the implementation; the test report is checked against section 12.

## 1. Existing architecture (do not change)

- The Nano ESP32 is a WiFi access point and serves the UI from flash with the synchronous `WebServer` class. There is no backend, no framework, no internet on that network.
- The control loop is a 200 Hz FreeRTOS task; HTTP and serial run in `loop()`. Shared state is plain `volatile` variables.
- Text commands (`/c?q=`) are shared with the Serial Monitor and must keep working unchanged.
- The classic Nano build must still compile; everything new is inside `#if HAS_WIFI`.
- No external firmware libraries.

## 2. Selected technologies

Vanilla HTML/CSS/JS concatenated by `tools/build_web.py` (Python standard library) into gzip blobs in `firmware/balance_robot/web_assets.h`. Custom WebGL2 renderer. Custom canvas charts. Gamepad API. Geist + Geist Mono subsets. No runtime dependencies.

## 3. Repository layout

```
web/index.html            one document for both routes
web/app.css               design system + layouts
web/js/00-lib.js          pure logic (also loaded by Node tests)
web/js/10-core.js         telemetry store, robot link, settings, toasts
web/js/20-twin.js         WebGL2 digital twin + 2D fallback
web/js/30-chart.js        strip charts
web/js/40-gamepad.js      Gamepad API input
web/js/50-control.js      control page
web/js/60-stats.js        statistics page
web/js/90-main.js         routing and start-up
web/fonts/                Geist subsets + OFL licence
web/model/cad/            the three STL files from the reference repo + notice
web/model/robot.bin       generated mesh
web/test/                 node --test suites
tools/build_twin.py       STL + parametric parts → robot.bin
tools/build_web.py        web/ → web_assets.h (the dev server calls it in memory)
tools/dev_server.py       simulated robot, or localhost bridge to the real one
firmware/balance_robot/web_assets.h   generated, committed (Arduino IDE users need no tools)
```

`web_page.h` is removed; every feature it had moves to the control page.

## 4. Firmware API

All additions are backward compatible in spirit; old endpoints keep their paths.

| Endpoint | Behaviour |
|---|---|
| `GET /` | 302 → `/control` |
| `GET /control`, `/statistics` | Same HTML shell, `Cache-Control: no-cache` |
| `GET /a/<hash>/<file>` | CSS, JS, `robot.bin`, fonts; gzip where useful; `Cache-Control: max-age=31536000, immutable` |
| `GET /t?s=<seq>&m=<msgseq>` | **Read-only** telemetry |
| `GET /j?v=&t=&c=<clientId>&s=&m=` | Drive command (honoured only for the armed owner) + the same telemetry payload |
| `GET /c?q=<command>[&c=<clientId>]` | Text command |
| `GET /s` | Static state: firmware, SSID, parameters, capabilities |

**Samples.** The control task pushes one sample every 4 ticks (50 Hz) into a 128-entry ring: `[t_ms, pitch×100, target×100, pitchRate×10, u, pwmL, pwmR, vEst×1000, roll×100, yawRate×10]`. `pwmL/pwmR` are the signed values actually written to each motor after friction compensation and steering. Roll is an accelerometer-only estimate, low-pass filtered; yaw rate is the gyro projected on the calibrated up axis.

**Telemetry payload.** `{"n":<head seq>,"d":[[...],...],"m":mode,"e":balance,"imu":0/1,"arm":0/1,"own":<id>,"tune":0/1,"fall":0/1,"rp":rampPwm,"lu":loopUs,"up":uptime_s,"st":stations,"pv":paramChecksum,"mq":<msg seq>,"ms":[...new messages...],"vb":volts?}`. At most 32 samples per response; a client that fell behind gets the newest 32 and detects the gap from sequence numbers. `vb` is present only when `BATTERY_PIN` is configured.

**Drive arming.**
- `arm` (`/c?q=arm&c=<id>`) is accepted only when balancing is enabled, the IMU is ok and autotune is off. It records the owner id and zeroes the drive command.
- `/j` values are applied only when armed **and** `c` equals the owner. Anything else is ignored (telemetry is still returned).
- Auto-disarm on: `disarm`, `off`, `estop`, a fall, autotune start, IMU loss, and no `/j` from the owner for `DRIVE_DISARM_MS` (2000 ms). The existing 600 ms neutral watchdog stays.
- `estop` = balancing off + disarm + autotune stop + test/calibration cancel, with a distinct status message. It is a software stop.
- Re-arming is always an explicit user action; nothing re-arms automatically.

**Diagnostics.** `webtest` (serial only): the robot requests each of its own assets over loopback and reports status, encoding and byte count.

**Optional battery sense.** `BATTERY_PIN` (default −1 = not fitted) and `BATTERY_DIVIDER` in `config.h`. Until fitted, the UI shows "not instrumented".

## 5. Two-page system

`/control` and `/statistics` are the same document; `90-main.js` reads `location.pathname`, removes the other page's markup and starts only that page's modules. Navigation uses ordinary links. The server keeps no page state, so each device is independent.

- **Control** polls `/j` every 80 ms (its heartbeat) and is the only page that sends commands.
- **Statistics** polls `/t` every 100 ms and is strictly read-only (no `/j`, no `/c`).
- Both feed the same telemetry store module, so the twin, charts and readouts are identical code on both pages.

## 6. Digital twin

**Source.** `models/base-deck.stl`, `mid-deck.stl`, `upper-deck.stl` of the reference repository, unmodified geometry (welded, quantized to 0.01 mm).

**Assembly (derived from the STL features).**
- Decks are 150 × 100 mm. Robot frame: x forward (STL +y), y left (STL −x), z up, ground at z = 0.
- Base plate 3 mm; its posts at (±63, ±38) carry the mid deck 48 mm above the base underside; the upper deck's posts put the top plate 101 mm above it.
- The base deck has motor slots on the centre line at both ends (STL x 56–75, y ±12) and bracket tabs at x = ±54: TT gear motors stand vertically in those slots with the shaft pointing outward. Axle height is taken at mid-plate, wheels are 65 mm, track about 194 mm.
- L298N on the four base bosses (±19, ±19). Controller board on the two mid-deck bosses (0, ±21). MPU6050 under the top-deck window on its bosses (±7.6, 9).
- Motors, wheels, boards are **parametric stand-ins** with catalogue dimensions, placed on the CAD's mounting features. The docs say so. No battery is drawn (its location is not in the CAD).

**Renderer.** WebGL2, one program. Flat normals from `dFdx/dFdy`, hemisphere + key light + rim term, per-part colour and glow, feature edges (dihedral > 28°) as lines, procedural ground grid with distance fade and contact shadow. Three nodes: body (pitch about the axle, roll about the ground line), left wheel, right wheel. Orbit with drag, DPR capped (2 desktop, 1.5 touch), render only when something changed. Canvas 2D side view when WebGL2 is missing.

**Telemetry mapping (and honesty rules).**
- Body pitch ← measured pitch. Body roll ← accelerometer roll estimate (labelled as such).
- Wheel rotation and ground scroll ← integral of the **commanded** PWM per side. Always labelled "estimated from command, no encoders". Never shown as a speed in physical units.
- Motor glow ← |pwmL|, |pwmR|. IMU tint ← IMU ok / error. Whole model dims when data is stale.
- Playback delay 120 ms with interpolation between samples.

**Shared component.** `Twin(canvas, {annotations})`. Control uses it plain; statistics passes annotation anchors and gets projected screen points each frame for leader lines.

## 7. Control page

Layout follows the sketch (phone in landscape): status strip on top, twin on the left, joystick on the right, joystick lock in the middle, padlock top right. In portrait it stacks: strip, twin, joystick, actions.

- **Status strip:** link (state + round-trip ms), mode, pitch, target, pitch rate, motor command L/R, IMU, battery (or "not instrumented"), loop time.
- **Joystick:** pointer events, radial dead zone, speed limit, knob mirrors gamepad input, disabled styling unless link is live and drive is armed. Release → neutral.
- **Drive lock ("joystick lock" in the sketch):** switch between *Balance only* and *Drive armed*.
- **Balance** on/off, **E-STOP** (always enabled, one tap), software-stop caption.
- **Navigation lock:** padlock toggles; locked = nav links inert, `beforeunload` guard, overscroll/pull-to-refresh suppressed. Unlock = press and hold 0.8 s.
- **Setup drawer:** Tuning (14 parameters, save/reload/defaults, autotune), Calibration, Tests, Controller mapping, Log. This is the old page's functionality.
- **Safety in the client:** neutral + disarm on `blur`, `visibilitychange`, `pagehide`, gamepad disconnect and link loss; after any of them the UI shows the lock closed and never re-arms by itself.

## 8. Statistics page

- **Annotated twin:** label cards in a left and a right column, each tied to a 3D anchor by a leader line. Lines are assigned per side by sorting anchors and cards by height, so they cannot cross. Cards: IMU (pitch, roll est., rate), Left motor, Right motor (command, direction), Motor driver (controller output, saturation), Controller (kp/kd/ks, loop time), Link (round trip, age, stations), Balance (target, speed estimate).
- **Charts:** pitch vs target; motor command L/R; pitch rate; speed estimate; link round trip; all with units, time axis, legend, cursor readout, window 10/30/60 s.
- **Diagnostics:** state, IMU, data freshness, sample gaps, poll errors, parameters, and generated warnings (stale data, saturation, fallen, IMU error, battery not instrumented).
- **Experiments:** record/stop; summary (duration, RMS error, max |pitch|, saturation %, mean |PWM|, falls) with the gains in force; sessions persisted in `localStorage`; CSV export; comparison table. Nothing is pre-filled.

## 9. Xbox controller

Gamepad API, standard mapping, polled in `requestAnimationFrame`.

| Input | Default action |
|---|---|
| Left stick Y | Forward / back |
| Right stick X (or left stick X in single-stick mode) | Turn |
| RT | Raises the speed limit toward 100 % |
| LT | Precision: scales the command down |
| A | Arm drive |
| X | Disarm (balance only) |
| B | E-STOP |
| Menu | Balance on |

Buttons are re-assignable ("press a button" capture), dead zone and layout configurable, settings persisted. A live schematic of the pad shows sticks, triggers and which button does what. Disconnect, blur or unsupported context → neutral + disarm; reconnect never re-arms. Capability is detected at run time; when the browser hides the API on an insecure origin the panel explains the localhost bridge.

## 10. Design system

Tokens: background `#050506`, surfaces in 4 grey steps, text `#f4f4f6` / `#a1a1aa` / `#6b6b76`, hairlines `rgba(255,255,255,.08)`, accent violet `#8b7cf6`, technical blue `#6aa9ff`, ok/warn/danger used only for state. Dotted backdrop and one violet light source behind the twin. Glass material for nav, strip, joystick, buttons, drawer and annotation cards. Geist for UI, Geist Mono with tabular figures for every number. Type scale 12/13/15/20/28/44 px, never below 12. Radii 10/14/20 and full pills for controls. Motion 120–220 ms ease-out, only on state change; `prefers-reduced-motion` removes it. Visible focus rings. Touch targets ≥ 44 px.

## 11. Performance budget

- Page weight from the robot ≤ 200 kB compressed, one time per device per firmware version.
- Twin ≤ 60 draw calls; no per-frame allocations in the render or poll paths.
- Charts redraw at most 20 Hz and only when visible.
- Robot: telemetry response built in a stack buffer; no heap churn in the control task.

## 12. Acceptance criteria

1. Both boards compile without warnings; classic Nano still fits.
2. `/control` and `/statistics` load from the same firmware and can be open at once; a statistics client never changes the drive command (verified on the simulated robot by driving from one page while the other is open).
3. Drive values are ignored unless armed by that client; link loss disarms; nothing re-arms automatically.
4. The twin shows the three real decks; pitch follows telemetry; wheel motion is labelled as an estimate.
5. Statistics leader lines do not cross; every displayed quantity exists in the telemetry; battery shows "not instrumented".
6. Charts update live with units; stopping the robot shows stale state instead of frozen "live" values.
7. Recording produces a summary and a CSV whose rows equal the recorded samples.
8. With a (simulated or real) standard-mapping gamepad: detection, axes, dead zone, button actions, disconnect → neutral + disarm.
9. No horizontal overflow or overlapping controls at 360×740, 740×360, 820×1180 and 1440×900.
10. Old functions (tuning, calibration, tests, autotune, save) are reachable and send the same commands.
11. Node tests and the dev-server smoke test pass.

## 13. Sequence

1. `build_twin.py` → `robot.bin`. 2. Firmware API + arming. 3. `dev_server.py` speaking the same API. 4. Core store + link. 5. Twin. 6. Control page. 7. Charts + statistics. 8. Gamepad. 9. Build into `web_assets.h`, compile, flash, `webtest`. 10. Browser tests at four sizes, fixes. 11. Docs and report.

## 14. Review notes (after re-reading this document against the code and research)

- *Contradiction fixed:* an early draft had the statistics page reuse `/j` with zero values; that would overwrite the driver's command (audit limitation 1). It now uses `/t` only.
- *Missing requirement added:* messages were single-slot; `ms` now returns every message since the client's `m`.
- *Missing requirement added:* a second control page must not steal control, hence the owner id.
- *Scope decision:* arming applies to the WiFi path. The serial `d` command keeps working on the classic Nano without arming, because that build has no room and no remote clients; on the ESP32, `d` also requires `arm`.
- *Risk recorded:* Gamepad API on `http://192.168.4.1` depends on the browser; it is tested at run time rather than assumed.
- *Risk recorded:* loopback `webtest` depends on lwIP loopback being enabled in the core; if not, HTTP serving on hardware must be verified from a phone.

What was built differs from this document in four small ways; they are listed in `IMPLEMENTATION_REPORT.md`, section 10.
