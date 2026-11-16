# Design and technology research

Research done on 2026-11-14 for the web redesign. Repository metadata (license, stars, last push, archived flag) was read from the GitHub API on that date. Library sizes were measured by downloading the published build from jsDelivr and compressing it with `gzip -9`.

## 0. The constraint that decides almost everything

The UI is served **by the robot itself**: an ESP32 acting as a WiFi access point, with a synchronous single-connection web server and about 2 MB of free flash (see `PROJECT_AUDIT.md`). Devices on that network have no internet. So every candidate was judged on four questions:

1. Can it be shipped from the robot's flash, offline, with no build chain the user must install?
2. How many compressed bytes does the ESP32 have to push per page load?
3. Does it fit a vanilla-JS codebase (there is no React, no bundler)?
4. Is the license compatible with an MIT repository?

## A. Interface systems and design references

| Repository | Purpose | License | Last push | Fit | Decision |
|---|---|---|---|---|---|
| [shadcn-ui/ui](https://github.com/shadcn-ui/ui) | Copy-paste React components on Radix + Tailwind | MIT | 2026-11 | Needs React + Tailwind + a bundler | **Patterns only**: its restrained dark tokens, 1 px borders and focus rings informed the token set |
| [radix-ui/primitives](https://github.com/radix-ui/primitives) | Accessible React primitives | MIT | 2026-10 | React only | **Patterns only**: keyboard/ARIA behaviour for the switch, slider and segmented control |
| [tailwindlabs/tailwindcss](https://github.com/tailwindlabs/tailwindcss) | Utility CSS framework | MIT | 2026-11 | Needs a Node build; adds a toolchain for about 20 kB of hand-written CSS | Rejected |
| [tabler/tabler](https://github.com/tabler/tabler) | Bootstrap admin dashboard kit | MIT | 2026-11 | Exactly the "generic admin panel" look to avoid; Bootstrap weight | Rejected |
| [tremorlabs/tremor](https://github.com/tremorlabs/tremor) | React dashboard components | Apache-2.0 | 2025-10 | React only | Rejected |
| [vercel/geist-font](https://github.com/vercel/geist-font) | Geist Sans + Geist Mono variable fonts | OFL-1.1 | 2026-11 | Self-hostable; Latin subset is 22 kB + 25 kB | **Selected** |
| [rsms/inter](https://github.com/rsms/inter) | Inter variable font | OFL-1.1 | 2024-11 | Good, but the variable file is several times larger and has no matching mono | Not selected |

**Liquid Glass implementations**

| Repository | Technique | License | Finding |
|---|---|---|---|
| [rdev/liquid-glass-react](https://github.com/rdev/liquid-glass-react) | React component; SVG displacement maps + shaders for edge refraction | MIT | React only. Its refraction relies on `backdrop-filter: url(#svg-filter)`, which only Chromium supports |
| [shuding/liquid-glass](https://github.com/shuding/liquid-glass) | Copy-paste SVG displacement shader | MIT | Same Chromium-only limitation; regenerates a displacement map in JS |
| [lucasromerodb/liquid-glass-effect-macos](https://github.com/lucasromerodb/liquid-glass-effect-macos) | CSS/SVG demo | none | No license, so it cannot be reused; reference only |

Decision: the control page must work on iPhone Safari and Android Chrome, so true refraction through SVG filters is out. The glass material is **hand-written CSS** that degrades cleanly: `backdrop-filter: blur() saturate()` over the dotted backdrop, a gradient hairline border, an inset top specular highlight, a soft inner shadow at the bottom, and pressed/hover states that move the highlight. No code was copied from these repositories.

**Robotics and engineering dashboards** (studied for layout and information design)

| Repository | Purpose | License | Finding |
|---|---|---|---|
| [lichtblick-suite/lichtblick](https://github.com/lichtblick-suite/lichtblick) | Robotics visualization suite (maintained fork of Foxglove Studio) | custom (no SPDX id reported) | Panel model: 3D scene beside plots that share one time base. Far too heavy to embed |
| [foxglove/studio](https://github.com/foxglove/studio) | Original Foxglove Studio | none reported | **Archived** (2024-07). Reference only |
| [rerun-io/rerun](https://github.com/rerun-io/rerun) | Multimodal robotics data viewer | Apache-2.0 | Timeline scrubbing and "entity + its time series" pairing inspired the annotated twin |
| [PlotJuggler/PlotJuggler](https://github.com/PlotJuggler/PlotJuggler) | Time-series tool | MPL-2.0 | Desktop app. Confirms the need for CSV export so recordings can be analysed there or in MATLAB |
| [cruise-automation/webviz](https://github.com/cruise-automation/webviz) | Web robotics visualization | Apache-2.0 | Unmaintained since 2022 |
| [RobotWebTools/ros3djs](https://github.com/RobotWebTools/ros3djs), [roslibjs](https://github.com/RobotWebTools/roslibjs), [gkjohnson/urdf-loaders](https://github.com/gkjohnson/urdf-loaders) | ROS web tooling | not machine-readable / none / Apache-2.0 | Require ROS + rosbridge + three.js. The robot has no ROS |

## B. 3D visualization

The CAD source ([adoodevv/self_balancing_robot](https://github.com/adoodevv/self_balancing_robot), `models/` only, MIT) contains three binary STL parts: `base-deck.stl` (3 444 triangles), `mid-deck.stl` (1 980) and `upper-deck.stl` (1 704). They are 150 × 100 mm plates with integrated posts; together 7 128 triangles and about 3 500 unique vertices. (`finale/correct-base.stl` is a different 200 × 120 mm base that does not match the other two decks or the reference render, so it is not used.)

| Option | Size (min / gzip) | License | Assessment |
|---|---|---|---|
| [mrdoob/three.js](https://github.com/mrdoob/three.js) r170 | 692 kB / 171 kB | MIT | Best general choice on a normal web host. Here it would be 5–6× the size of the whole rest of the app, for one static low-poly model |
| [pmndrs/react-three-fiber](https://github.com/pmndrs/react-three-fiber) | three.js + React | MIT | No React in the project |
| [BabylonJS/Babylon.js](https://github.com/BabylonJS/Babylon.js) 7 | 6.2 MB / 1.29 MB (UMD) | Apache-2.0 | Does not fit the flash budget sensibly |
| [google/model-viewer](https://github.com/google/model-viewer) | bundles three.js | Apache-2.0 | No per-node animation control for pitch and wheels |
| [greggman/twgl.js](https://github.com/greggman/twgl.js) | 96 kB / 27 kB | MIT | Thin helper; the renderer needs about 250 lines without it |
| [oframe/ogl](https://github.com/oframe/ogl) | small | none in metadata | Unclear license |
| **Custom WebGL2 renderer** | about 4 kB gzip | — | One shader, flat shading from screen-space derivatives, feature-edge lines, three transform nodes |
| glTF + [glTF-Transform](https://github.com/donmccurdy/glTF-Transform), [meshoptimizer](https://github.com/zeux/meshoptimizer), [Draco](https://github.com/google/draco) | decoder 20–100 kB+ | MIT / Apache-2.0 | Compression pays off for meshes of 100 k+ triangles. This model is under 15 k; quantized int16 + gzip already gives about 30 kB |
| Blender, [trimesh](https://github.com/mikedh/trimesh), [fast-simplification](https://github.com/pyvista/fast-simplification) | conversion / decimation | GPL / MIT | Not needed: the STLs are small enough to ship unmodified |

**Decision: real 3D, custom WebGL2 renderer, custom binary mesh.** The three decks are shipped as they are in the CAD (welded and quantized to 0.01 mm, no decimation). A Python build script with no dependencies writes `robot.bin`. Devices without WebGL2 get a 2D canvas side view driven by the same telemetry.

## C. Telemetry charts

| Library | Size (min / gzip) | License | Assessment |
|---|---|---|---|
| [leeoniya/uPlot](https://github.com/leeoniya/uPlot) 1.6 | 50 kB / 22 kB | MIT | The right library if one is used: built for streaming time series |
| [chartjs/Chart.js](https://github.com/chartjs/Chart.js) 4 | 206 kB / 69 kB | MIT | General purpose; slower with 50 Hz streams |
| [apache/echarts](https://github.com/apache/echarts) 5 | 1.03 MB / 333 kB | Apache-2.0 | Too large to serve from the robot |
| [plotly/plotly.js](https://github.com/plotly/plotly.js) | 4.56 MB / 1.33 MB | MIT | Larger than the free flash |
| [joewalnes/smoothie](https://github.com/joewalnes/smoothie) | small | no SPDX id reported | Last pushed 2023; no axes with units |
| **Custom canvas strip chart** | about 3 kB gzip | — | Draws straight from the shared typed-array ring buffers |

**Decision: custom canvas strip chart.** The need is narrow (fixed time window, 2–3 series, units, cursor readout, hi-DPI). Reading the telemetry rings directly avoids copying data into a library's format 50 times per second on a phone. uPlot is the documented upgrade path if zoom/pan is wanted later.

## D. Real-time transport

| Option | Assessment |
|---|---|
| WebSockets via [Links2004/arduinoWebSockets](https://github.com/Links2004/arduinoWebSockets) (LGPL-2.1) or [ESP32Async/ESPAsyncWebServer](https://github.com/ESP32Async/ESPAsyncWebServer) (LGPL-3.0) | Lowest latency, but adds external libraries (the firmware has none by design), LGPL code in an MIT repo, and replaces a server that is proven on this robot |
| Server-Sent Events | Needs a long-lived connection, which the synchronous `WebServer` cannot hold while serving others |
| **HTTP polling with batched samples** | Robot buffers samples at 50 Hz; each 10 Hz poll returns everything since the client's last sequence number. No new dependency, works for any number of devices, loses nothing on a missed poll |

**Decision: batched polling.** Display latency is about one poll period, which the twin hides by playing samples back with a fixed 120 ms delay.

## E. Virtual joystick

[yoannmoinet/nipplejs](https://github.com/yoannmoinet/nipplejs) (MIT, 20 kB / 6 kB, pushed 2026-05) is a good library, but the app needs one fixed joystick whose knob can also be driven by the gamepad and which must reflect arm/link state. That is about 60 lines of pointer-event code, so it stays custom (as it already was).

## F. Xbox controller

**Path:** `Xbox controller → OS driver (USB / Xbox Wireless / Bluetooth) → browser Gamepad API → control page → same /j command as the virtual joystick → robot`. The controller never talks to the robot directly.

Findings:

- **API:** `navigator.getGamepads()` polled per frame, plus `gamepadconnected` / `gamepaddisconnected`. Xbox controllers report `mapping: "standard"` in Chromium, Firefox and Safari: axes 0/1 left stick, 2/3 right stick, buttons 0–3 A/B/X/Y, 4/5 LB/RB, 6/7 LT/RT (analog `value`), 8 View, 9 Menu, 10/11 stick clicks, 12–15 D-pad, 16 Xbox.
- **User gesture:** browsers expose a pad only after a button is pressed while the page is focused, and stop updating it when the page loses focus. The app therefore neutralises and disarms on blur.
- **Hardware models:** Xbox One controllers 1537 and 1697 have **no Bluetooth** (USB cable or the Xbox Wireless Adapter only). Model 1708 (2016, Xbox One S) and later add Bluetooth. Sources disagree on whether 1708 uses Bluetooth Classic or LE before a firmware update; pairing support therefore depends on the OS.
- **Platforms:** Windows 10/11, macOS, ChromeOS, Linux and Android pair 1708+ over Bluetooth; iOS/iPadOS 13+ supports 1708+ in Safari. USB works on desktop OSes.
- **Secure context (important here):** the W3C spec restricts the Gamepad API to secure contexts. **Firefox enforces it** (announced for Firefox 81; reported as enforced from 91): on `http://192.168.4.1` the API returns nothing. **Chromium:** the restriction sits behind the `RestrictGamepadAccess` feature / `chrome://flags/#restrict-gamepad-access`, which was disabled by default in the Chromium 114 source. Measured during this work: in Chromium 156, on a plain-HTTP LAN origin (`isSecureContext === false`), `navigator.getGamepads()` exists and returns its slot array without throwing. Whether it reports a physical controller on such an origin was not tested (no controller was available), so the app detects it at run time. **Safari** has announced the same restriction.
- **Fallbacks implemented:** run-time detection with a clear message, and a localhost bridge (`tools/dev_server.py --robot http://192.168.4.1`): `http://localhost` is a secure context in every browser, and the bridge proxies the robot's API. In Chromium, `chrome://flags/#unsafely-treat-insecure-origin-as-secure` with `http://192.168.4.1` is the alternative.
- **Latency:** USB and Xbox Wireless polling is 4–8 ms; Bluetooth typically adds 10–30 ms. Both are small next to the 80 ms command period.
- [alvaromontoro/gamecontroller.js](https://github.com/alvaromontoro/gamecontroller.js) (MIT, last pushed 2023) wraps the API with events. Not needed: edge detection and a radial dead zone are about 40 lines.

Sources: [Mozilla Hacks, "Securing Gamepad API"](https://hacks.mozilla.org/2020/07/securing-gamepad-api/) · [Mozilla bug 1704005](https://bugzilla.mozilla.org/show_bug.cgi?id=1704005) · [blink-dev, "Intent to Ship: Restrict Gamepad usage"](https://groups.google.com/a/chromium.org/g/blink-dev/c/B1QUuICApvc) · [w3c/gamepad #145](https://github.com/w3c/gamepad/issues/145) · [MDN `getGamepads()`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/getGamepads) · [Wikipedia, Xbox Wireless Controller](https://en.wikipedia.org/wiki/Xbox_Wireless_Controller) · [iFixit, model 1708](https://www.ifixit.com/Device/Xbox_One_Wireless_Controller_Model_1708)

## G. Selected stack

| Concern | Choice | Why |
|---|---|---|
| Framework | None: HTML + CSS + vanilla JS, concatenated by a Python script | Matches the existing code; no Node toolchain; smallest payload |
| Routing | Two real paths, `/control` and `/statistics`, same document | Each device picks its page; the server keeps no page state |
| 3D | Custom WebGL2 renderer + `robot.bin` from the real STLs | About 4 kB of code instead of 171 kB |
| Charts | Custom canvas strip charts on shared ring buffers | No copies, no dependency |
| Transport | HTTP polling with 50 Hz batched samples | No external firmware library |
| Controller | Gamepad API, standard mapping, run-time capability check | Works wherever the browser allows it; documented fallback |
| Fonts | Geist + Geist Mono (OFL-1.1), Latin subset, served from flash | Offline, 47 kB total, tabular figures |
| Glass material | Hand-written CSS (blur + saturate + specular borders) | Works in Safari, Chrome and Firefox |
| Asset delivery | gzip in flash, `Content-Encoding: gzip`, content-hashed URLs cached for a year | One download per device per firmware version |
| Tests | `node --test` for pure logic, Python dev server with a simulated robot, browser checks | No new runtime dependency |

New runtime dependencies added to the project: **none**. Build-time tools: Python 3 (standard library only). Fonts were subset once with `fonttools`.

## H. Second pass (2026-11-15): charts, typography, cover

**Charts.** Tools built for inspecting telemetry share a small set of conventions, and the first version of the Statistics page followed none of them (it was a grid of separate cards). What was adopted:

| Convention | Seen in | Implemented as |
|---|---|---|
| Cursor shared by all panels, keyed by time and not by pixel | [Grafana shared crosshair](https://answers.splunk.com/answers/392159/index.html), [F1Laps telemetry](https://www.f1laps.com/blog/telemetry-synchronized-cursor-charts/), [ZingChart shared interactions](https://docs.zingchart.com/tutorials/features/shared-interactions) | One `ChartView` object holds the cursor time; every chart reads its value at that time |
| Stacked rows with one time axis | Oscilloscopes, PlotJuggler, [Sift time-series panel](https://www.siftstack.com/mission-critical/open-zoom-share-the-time-series-panel-in-sift) | A single bordered panel of rows; only the last row carries time labels |
| Pause before inspecting; X zoom separate from pan | [Zelos plot panel](https://zelos-docs.pages.dev/app/panels/plot-panel/), Sift | Pause freezes the right edge while data keeps buffering; drag pans, wheel zooms the window; double-click returns to live |
| No interpolation across missing data | General practice in engineering plots | The line is lifted when two samples are more than 100 ms apart |
| Stable vertical scale | Oscilloscope auto-range with hold | The range grows immediately and shrinks slowly |
| Limits drawn on the plot | Control-room displays | Dashed reference lines at the ±255 PWM limit |

The renderer stays custom (about 4 kB gzip). uPlot remains the documented alternative; its cursor-sync API was not needed once the view object existed.

**PID chart.** The proportional, integral and derivative terms are now part of each telemetry sample, computed by the firmware in the control step, so the chart shows what the controller actually added up rather than a reconstruction in the browser.

**Typography.** Geist was replaced because it is the default of many generated interfaces and gave the app that look. Eight open-licence families were rendered side by side in a specimen sheet with the app's own strings (a light headline, numeric read-outs, small caps labels): Hanken Grotesk, Host Grotesk, Instrument Sans, Schibsted Grotesk, Red Hat Mono, DM Mono, IBM Plex Mono and Azeret Mono. Chosen: **Hanken Grotesk** (closest to the light grotesque of the cover artwork) and **Red Hat Mono** (a light, open monospace with clear numerals). Both are OFL-1.1, from [google/fonts](https://github.com/google/fonts); weight ranges were trimmed and the files subset to Latin: 27 kB + 19 kB.

**Visual language.** Taken from the cover artwork rather than from a component kit: white pills for what can be pressed, a dark pill for navigation, a light headline with a second clause in grey, monospace uppercase micro-labels. Panels are flat with hairlines; translucent material is kept only for elements that float over the twin. Violet is used for live data and armed states only.

**Cover.** The supplied artwork is used unmodified as the cover (`/`), with transparent link areas over its own navigation and buttons, so it is pixel-identical to the file. It is 133 kB and is requested only by the cover page.
