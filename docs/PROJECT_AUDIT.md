# Project audit (before the web redesign)

Audit of the repository as it stood on branch `fix/speed-loop-latch` (commit `14babee`), made by reading the source and by talking to the real robot over USB serial.

## 1. Architecture

There is **no separate frontend framework and no backend server**. The robot is the server.

```
Browser (phone / PC)  ──HTTP over the robot's own WiFi AP──►  Arduino Nano ESP32
                                                              ├─ loop() task: WebServer + serial commands
                                                              └─ control task (FreeRTOS, 200 Hz, core 1)
                                                                    MPU6050 (I2C) → cascade controller → L298N → motors
```

| Layer | What exists |
|---|---|
| Firmware | One Arduino sketch, `firmware/balance_robot/`, for the classic Nano (serial only) and the Nano ESP32 (serial + WiFi). No external libraries |
| Web UI | A single HTML document (HTML + CSS + vanilla JS, about 9 kB) stored as a raw string in `web_page.h` and served from flash at `/` |
| Transport | Plain HTTP/1.1 on the ESP32 `WebServer` class (synchronous, one request at a time, `Connection: close`). No WebSockets, MQTT, Bluetooth or SSE |
| Network | The ESP32 is a WiFi access point (`BalanceBot-XXXX`, WPA2 password, `192.168.4.1`). Devices joined to it have **no internet access** |
| Simulation | `matlab/`: nonlinear model with a line-by-line copy of the firmware controller |

## 2. Important files

| File | Role |
|---|---|
| `firmware/balance_robot/balance_robot.ino` | Control loop, calibration, autotune, command parser, HTTP handlers |
| `firmware/balance_robot/config.h` | Pins, loop constants, default gains, AP name/password |
| `firmware/balance_robot/mpu6050_raw.h` | Register-level MPU6050 driver |
| `firmware/balance_robot/web_page.h` | The whole current web UI |
| `matlab/controller_step.m` | MATLAB mirror of `runStep()` (must stay in sync with the firmware) |
| `README.md`, `matlab/README.md`, `docs/wiring.svg` | Documentation |

## 3. HTTP API (as found)

| Endpoint | Purpose |
|---|---|
| `GET /` | The HTML page |
| `GET /j?v=<fwd>&t=<turn>` | Sets the drive command (−1..1) **and** returns telemetry JSON. Polled every 100 ms |
| `GET /c?q=<command>` | Runs one text command (same parser as the Serial Monitor) and returns its text output |
| `GET /s` | Firmware version, SSID, all parameters, telemetry |

Telemetry fields: pitch angle `a` (°), target angle `t` (°), pitch rate `r` (°/s), controller output `u` (PWM, −255..255), speed estimate `v` (fraction of PWM, not m/s), auto-trim `at` (°), mode `m`, balance enabled `e`, IMU ok `imu`, autotune `tune`, ramp PWM `rp`, control-loop time `lu` (µs), last status message `msg` with sequence `sq`.

## 4. How things work today

- **Motor commands:** the page polls `/j` with the joystick position. The firmware slew-limits it and zeroes it if no `/j` arrives for 600 ms (`CMD_TIMEOUT_MS`).
- **Connection status:** inferred by the page from failed polls (3 in a row → "no connection").
- **Safety already present:** fall cut-off at 40°, balancing off on an uncalibrated board, IMU-loss handling, speed-loop latch breaker, joystick ignored during autotune.
- **Working functionality (verified on the real board over serial and by the user in the app):** balancing loop, live tuning of 14 parameters, save/load, gyro/upright/forward calibration, motor test, minimum-PWM ramp, motor inversion, autotune, I2C scan, WiFi diagnostics.

## 5. Limitations that shape the redesign

1. **Every `/j` poll writes the drive command.** A second device that only wants to watch would overwrite the first device's joystick with zeros. A read-only telemetry endpoint and command ownership are required for two devices.
2. **10 Hz, last-value telemetry.** One sample per poll is too coarse for charts and for a smooth digital twin. The control loop runs at 200 Hz, so samples must be buffered on the robot and delivered in batches.
3. **Only the last status message is delivered**, so messages are lost when several are produced between polls.
4. **No arm state for driving.** Any client that sends `/j` drives the robot.
5. **No internet on the robot's network.** CDNs, web fonts and online libraries cannot be loaded. Every byte of the UI must come from the ESP32 flash.
6. **Synchronous web server on a microcontroller.** Large responses block other clients while they are sent; assets must be small, compressed and cacheable.
7. **Flash budget.** The sketch uses 1.02 MB of the 3.1 MB application partition, leaving about 2 MB.
8. **Not measured by the hardware:** battery voltage (no divider wired), wheel speed (no encoders), motor current. Roll and yaw rate are available from the IMU but were not computed.
9. **Plain HTTP origin (`http://192.168.4.1`) is not a secure context.** Browser features restricted to secure contexts (Gamepad API in Firefox, Wake Lock, etc.) need a fallback.
10. **Classic Nano:** 90 % of flash used. All new features must stay inside `#if HAS_WIFI`.
11. **No automated tests** existed for the web UI; the firmware is verified by compiling for both boards and by serial sessions with the robot.

## 6. Constraints adopted

- Keep the firmware free of external libraries and keep the classic Nano build working.
- Keep the existing text command set; extend the HTTP API in a backward-compatible way.
- The UI must work fully offline from the robot, on phones, with assets served from flash.
- Never display a value the robot does not measure; label estimates as estimates.
