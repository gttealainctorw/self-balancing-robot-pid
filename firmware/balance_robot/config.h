// =====================================================================
//  config.h  —  Hardware configuration and default parameters
//
//  The same firmware builds for:
//    * Arduino Nano (ATmega328P)     -> tuning over the Serial Monitor
//    * Arduino Nano ESP32 (ABX00092) -> Serial Monitor + WiFi app
//
//  Both boards use the SAME screw terminals on the Nano terminal shield
//  (D2..D9, A4, A5), so you can swap boards without rewiring. Only change:
//    Classic Nano : MPU6050 VCC -> 5V terminal
//    Nano ESP32   : MPU6050 VCC -> 3V3 terminal (the "5V/VBUS" pin of the
//                   Nano ESP32 is only powered while USB is connected)
// =====================================================================
#pragma once

// ---------------------------------------------------------------------
//  Pins (L298N + MPU6050) — match docs/wiring.svg
// ---------------------------------------------------------------------
#if defined(ARDUINO_ARCH_ESP32)
  // Dx macros work with any "Pin Numbering" option of the Nano ESP32
  #define PIN_ENA  D9   // PWM motor A (left)
  #define PIN_IN1  D7
  #define PIN_IN2  D8
  #define PIN_IN3  D5
  #define PIN_IN4  D4
  #define PIN_ENB  D3   // PWM motor B (right)
  #define PIN_MPU_INT D2 // wired but unused (the IMU is polled at 200 Hz)
#else
  #define PIN_ENA  9    // ~D9  PWM motor A (left)
  #define PIN_IN1  7
  #define PIN_IN2  8
  #define PIN_IN3  5
  #define PIN_IN4  4
  #define PIN_ENB  3    // ~D3  PWM motor B (right)
  #define PIN_MPU_INT 2
#endif
// SDA = A4, SCL = A5 on both boards (default Wire pins)

// ---------------------------------------------------------------------
//  Control loop
// ---------------------------------------------------------------------
#define LOOP_HZ          200        // control loop rate
#define MPU_DLPF_CFG     3          // MPU internal low-pass filter: 3 = ~42 Hz
#define GYRO_LSB_PER_DPS 65.5f      // ±500 °/s range
#define FALL_ANGLE       40.0f      // |angle| above this => fallen, motors OFF
#define ARM_ANGLE        3.0f       // |angle - trim| below this for ARM_TIME_MS => start
#define ARM_TIME_MS      400
#define I_TERM_LIMIT     120.0f     // integral anti-windup (PWM units)
#define CMD_TIMEOUT_MS   600        // no app command for this long => joystick back to 0
#define SAT_PWM          250.0f     // |PWM| at or above this counts as saturated
#define SOFT_START_MS    1500       // the speed loop fades in over this time after starting
#define LATCH_MS         250        // saturated this long while nearly upright => reset speed loop
#define LATCH_ANGLE      6.0f       // "nearly upright" for the latch breaker (degrees)
#define DRIVE_SLEW       1.5f       // max rate of the forward/back command (1/s)
#define TURN_SLEW        4.0f       // same for turning

// ---------------------------------------------------------------------
//  Default tunable parameters
//  (stored in EEPROM/flash with the "save" command or the Save button)
//  Chosen with the simulation in matlab/ for yellow TT 1:48 motors + 2x18650.
// ---------------------------------------------------------------------
#define DEF_KP      45.0f   // PWM per degree of error
#define DEF_KI       0.0f   // PWM per (degree·s)
#define DEF_KD       0.6f   // PWM per (°/s) — uses the filtered gyro rate
#define DEF_DLPF     0.5f   // smoothing of the D term (0 = none, 0.9 = heavy)
#define DEF_TRIM     0.0f   // fine correction of the balance point (degrees)
#define DEF_KS      20.0f   // speed loop: degrees of lean per unit of speed
#define DEF_KIS      0.0f   // speed-loop integral (auto-trim). 0.5–2 removes drift
#define DEF_VMAX     0.35f  // target speed at full joystick (fraction of PWM)
#define DEF_TAUV     0.20f  // time constant of the speed estimator (s)
#define DEF_LEAN    10.0f   // max lean the speed loop may request (degrees)
#define DEF_MINPWM  28.0f   // lowest PWM that turns the wheels (measure with "ramp")
#define DEF_DB       2.0f   // dead band: |output| below this => motors stopped
#define DEF_TURN    60.0f   // differential PWM at full turn
#define DEF_ALPHA    0.99f  // complementary filter (gyro weight)

// ---------------------------------------------------------------------
//  WiFi (Nano ESP32 only): the robot creates its own network
// ---------------------------------------------------------------------
#define AP_SSID_PREFIX "BalanceBot"   // 4 unique hex digits are appended
#define AP_PASSWORD    "balance123"   // at least 8 characters
#define AP_CHANNEL     6              // 2.4 GHz channel (1-13)
