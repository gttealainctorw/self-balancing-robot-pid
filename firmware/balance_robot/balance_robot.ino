/*
  =====================================================================
   Self-balancing robot — inverted pendulum on two wheels
   Cascade control: angle PID + speed loop (no encoders needed)
  =====================================================================
   Supported boards (same code, detected automatically):
     * Arduino Nano (ATmega328P)     -> tuning over the Serial Monitor
     * Arduino Nano ESP32 (ABX00092) -> Serial Monitor + WiFi app
       (joystick to drive it + live PID tuning + live plot)

   Hardware: L298N, MPU6050 (GY-521), 2 DC motors, 7.4–12 V battery.
   Wiring: see docs/wiring.svg and config.h

   NO external libraries: the MPU6050 is read register by register.

   Control structure (every 5 ms):
     1. angle  = complementary filter (gyro + accelerometer)
     2. vEst   = low-pass filter of the applied PWM (speed estimate)
     3. target = trim + ks·(vRef − vEst) + kis·∫(vRef − vEst)
     4. PWM    = kp·(angle − target) + ki·∫error + kd·filtered_gyro
     5. turn   = ±turn on each wheel, minimum-PWM compensation
   The simulation in matlab/ shows why step 3 is needed: an angle-only
   PID leaves an unstable "drift" mode with DC motors.
  =====================================================================
*/
#include <Wire.h>
#include <EEPROM.h>
#include <math.h>
#include "config.h"
#include "mpu6050_raw.h"

#if defined(ARDUINO_ARCH_ESP32)
  #define HAS_WIFI 1
  #include <WiFi.h>
  #include <WebServer.h>
  #include <esp_mac.h>
  #include "web_page.h"
#else
  #define HAS_WIFI 0
#endif

#define FW_VERSION   "1.0.0"
#define PARAMS_MAGIC 0xB0B1   // change it if you modify the Params struct

const float    DT    = 1.0f / LOOP_HZ;
const uint32_t DT_US = 1000000UL / LOOP_HZ;

// ---------------------------------------------------------------------
//  Persistent parameters
// ---------------------------------------------------------------------
struct Params {
  uint16_t magic;
  float kp, ki, kd, dlpf;
  float trim, ks, kis, vmax, tauv, lean;
  float minpwm, db, turn, alpha;
  float up[3];    // "up" direction (robot balanced) in sensor axes
  float fwd[3];   // where gravity moves in sensor axes when tilting forward
  float gb[3];    // gyro bias (fallback if it cannot be calibrated at power-up)
  uint8_t invL, invR;
};

struct ParamDef {
  const char* name;
  float* ptr;
  float lo;
  float hi;
};

Params P;

ParamDef PDEF[] = {
  {"kp", &P.kp, 0, 500},       {"ki", &P.ki, 0, 2000},       {"kd", &P.kd, 0, 50},
  {"dlpf", &P.dlpf, 0, 0.98f}, {"trim", &P.trim, -15, 15},   {"ks", &P.ks, 0, 300},
  {"kis", &P.kis, 0, 200},     {"vmax", &P.vmax, 0, 1},      {"tauv", &P.tauv, 0.02f, 5},
  {"lean", &P.lean, 0, 25},    {"minpwm", &P.minpwm, 0, 200}, {"db", &P.db, 0, 60},
  {"turn", &P.turn, 0, 255},   {"alpha", &P.alpha, 0.9f, 0.9995f},
};
const uint8_t N_PDEF = sizeof(PDEF) / sizeof(PDEF[0]);

// ---------------------------------------------------------------------
//  State
// ---------------------------------------------------------------------
enum Mode : uint8_t { MODE_IDLE = 0, MODE_RUN, MODE_CAL, MODE_MTEST, MODE_RAMP };
enum CalKind : uint8_t { CAL_GYRO = 0, CAL_UP, CAL_FWD };
const uint8_t NO_REQ = 0xFF;

MPU6050Raw imu;

volatile uint8_t  mode = MODE_IDLE;
volatile uint8_t  reqMode = NO_REQ;     // mode change request (applied by the loop)
volatile uint8_t  reqCal = CAL_GYRO;
volatile bool     motorsEnabled = true;
volatile bool     fallen = false;
volatile bool     imuOk = false;
volatile bool     rampOkReq = false;
volatile bool     reqScan = false;      // "i2c" command: scan the bus from the control loop
volatile float    driveCmd = 0, turnCmd = 0;  // -1..1 from the app / "d" command
volatile uint32_t lastCmdMs = 0;

float pitchAxis[3];
float gBias[3] = {0, 0, 0};
float angle = 0, rate = 0, rateF = 0, tgt = 0, uOut = 0;
float vEst = 0, autoTrim = 0, iTerm = 0, driveSm = 0, turnSm = 0;
bool  angleInit = false;
uint16_t armTicks = 0;
uint16_t runTicks = 0;      // ticks since balancing started (soft start of the speed loop)
uint16_t satTicks = 0;      // consecutive saturated ticks while nearly upright (latch breaker)
uint16_t imuRetryTicks = 0;
uint8_t  i2cErrors = 0;
uint16_t loopUs = 0;
int      rampPwm = 0;
uint32_t modeTicks = 0;
bool     telemetryOn = false;

// calibration
uint8_t  calKind = CAL_GYRO;
uint16_t calN = 0;
uint8_t  calTries = 0;
bool     calMoved = false;
float    calSum[3];
int16_t  calRef[3];
const uint16_t CAL_SAMPLES_GYRO = 400;  // 2 s
const uint16_t CAL_SAMPLES_ACC  = 200;  // 1 s

// autotune: pattern search on kp, kd, ks while the robot balances
const uint16_t AT_WIN  = 4 * LOOP_HZ;    // ticks per evaluation (4 s)
const uint16_t AT_SKIP = 1 * LOOP_HZ;    // ignore the first second after (re)starting
const float AT_REF[3] = {45.0f, 0.6f, 20.0f};   // scale for steps when a gain is small
const float AT_LO[3]  = {10.0f, 0.0f, 0.0f};
const float AT_HI[3]  = {150.0f, 5.0f, 60.0f};
const float AT_RESCUE[4] = {1.5f, 0.67f, 2.0f, 0.5f};  // tried when the start gains cannot balance
volatile bool atReqStart = false, atReqStop = false;
volatile bool atOn = false;
uint8_t  atPi = 0, atTrial = 0, atBaseFalls = 0, atRescue = 0;
bool     atImproved = false;
float    atStep = 0.25f, atJbase = -1.0f;
float    atBase[3], atOrig[3];
uint16_t atN = 0, atSkip = 0;
float    atSE = 0, atSDu = 0, atSV = 0, atSSat = 0;

#if HAS_WIFI
  // On the ESP32 the control loop runs in its own task: messages are queued
  // here and printed by loop(), so the control loop never waits on USB/WiFi.
  const uint8_t MSG_SLOTS = 8;
  char msgRing[MSG_SLOTS][72];
  volatile uint16_t msgHead = 0;   // total messages published
  uint16_t msgPrinted = 0;
  WebServer server(80);
  char apSsid[24];
  bool apStarted = false;
#else
  uint32_t nextTick = 0;
#endif

// ---------------------------------------------------------------------
//  Messages
// ---------------------------------------------------------------------
void report(const char* msg) {
#if HAS_WIFI
  uint16_t h = msgHead;
  strncpy(msgRing[h % MSG_SLOTS], msg, sizeof(msgRing[0]) - 1);
  msgRing[h % MSG_SLOTS][sizeof(msgRing[0]) - 1] = 0;
  msgHead = h + 1;
#else
  Serial.println(msg);
#endif
}

void report(const __FlashStringHelper* msg) {
#if HAS_WIFI
  report((const char*)msg);
#else
  Serial.println(msg);
#endif
}

// ---------------------------------------------------------------------
//  Vectors
// ---------------------------------------------------------------------
static inline float dot3(const float* a, const float* b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

static void cross3(const float* a, const float* b, float* o) {
  o[0] = a[1] * b[2] - a[2] * b[1];
  o[1] = a[2] * b[0] - a[0] * b[2];
  o[2] = a[0] * b[1] - a[1] * b[0];
}

static bool norm3(float* v) {
  float n = sqrtf(dot3(v, v));
  if (n < 1e-6f) return false;
  v[0] /= n; v[1] /= n; v[2] /= n;
  return true;
}

// Orthonormalizes up/fwd and computes the gyro pitch axis:
//   angle = atan2(a·fwd, a·up)      rate = ω·(fwd × up)
void updateAxes() {
  if (!norm3(P.up)) { P.up[0] = 0; P.up[1] = 0; P.up[2] = 1; }
  float d = dot3(P.fwd, P.up);
  for (uint8_t i = 0; i < 3; i++) P.fwd[i] -= d * P.up[i];
  if (!norm3(P.fwd)) {
    float ref[3] = {1, 0, 0};
    if (fabsf(P.up[0]) > 0.9f) { ref[0] = 0; ref[1] = 1; }
    float tmp[3];
    cross3(P.up, ref, tmp);
    cross3(tmp, P.up, P.fwd);
    norm3(P.fwd);
  }
  cross3(P.fwd, P.up, pitchAxis);
  norm3(pitchAxis);
}

// ---------------------------------------------------------------------
//  Parameters: defaults, load and save
// ---------------------------------------------------------------------
void setDefaultTuning() {
  P.kp = DEF_KP;     P.ki = DEF_KI;     P.kd = DEF_KD;     P.dlpf = DEF_DLPF;
  P.trim = DEF_TRIM; P.ks = DEF_KS;     P.kis = DEF_KIS;   P.vmax = DEF_VMAX;
  P.tauv = DEF_TAUV; P.lean = DEF_LEAN; P.minpwm = DEF_MINPWM;
  P.db = DEF_DB;     P.turn = DEF_TURN; P.alpha = DEF_ALPHA;
}

void setDefaults() {
  P.magic = PARAMS_MAGIC;
  setDefaultTuning();
  // Assumed mounting: GY-521 X arrow pointing forward, chip facing up
  P.up[0] = 0;   P.up[1] = 0;  P.up[2] = 1;
  P.fwd[0] = -1; P.fwd[1] = 0; P.fwd[2] = 0;
  P.gb[0] = 0;   P.gb[1] = 0;  P.gb[2] = 0;
  P.invL = 0;    P.invR = 0;
}

bool paramsValid() {
  for (uint8_t i = 0; i < N_PDEF; i++) {
    float v = *PDEF[i].ptr;
    if (isnan(v) || v < PDEF[i].lo || v > PDEF[i].hi) return false;
  }
  for (uint8_t i = 0; i < 3; i++) {
    if (isnan(P.up[i]) || isnan(P.fwd[i]) || isnan(P.gb[i])) return false;
  }
  return P.invL <= 1 && P.invR <= 1;
}

void loadParams() {
  EEPROM.get(0, P);
  if (P.magic != PARAMS_MAGIC || !paramsValid()) {
    setDefaults();
    motorsEnabled = false;   // uncalibrated board: never move the motors on its own
    report(F("EEPROM empty or invalid: using defaults"));
    report(F("Balancing OFF until calibrated: calup, calfwd, mt, then 'on'"));
  }
  updateAxes();
}

bool saveParams() {
  if (mode == MODE_RUN) return false;   // writing flash takes time: not while balancing
  P.magic = PARAMS_MAGIC;
  EEPROM.put(0, P);
#if HAS_WIFI
  EEPROM.commit();
#endif
  return true;
}

// ---------------------------------------------------------------------
//  Motors (L298N)
// ---------------------------------------------------------------------
void driveRaw(uint8_t en, uint8_t in1, uint8_t in2, int pwm) {
  pwm = constrain(pwm, -255, 255);
  if (pwm > 0)      { digitalWrite(in1, HIGH); digitalWrite(in2, LOW); }
  else if (pwm < 0) { digitalWrite(in1, LOW);  digitalWrite(in2, HIGH); }
  else              { digitalWrite(in1, LOW);  digitalWrite(in2, LOW); }
  analogWrite(en, pwm >= 0 ? pwm : -pwm);
}

void motorL(int pwm) { driveRaw(PIN_ENA, PIN_IN1, PIN_IN2, P.invL ? -pwm : pwm); }
void motorR(int pwm) { driveRaw(PIN_ENB, PIN_IN3, PIN_IN4, P.invR ? -pwm : pwm); }
void motorsOff()     { motorL(0); motorR(0); }

// Dead band + friction compensation: maps |x| from [db, 255] to [minpwm, 255]
int frictionComp(float x) {
  float a = fabsf(x);
  if (a < P.db) return 0;
  float out = P.minpwm + (a - P.db) * (255.0f - P.minpwm) / (255.0f - P.db);
  if (out > 255.0f) out = 255.0f;
  int o = (int)(out + 0.5f);
  return x > 0 ? o : -o;
}

// ---------------------------------------------------------------------
//  Calibration
// ---------------------------------------------------------------------
void startCal(uint8_t kind) {
  calKind = kind;
  calN = 0;
  calTries = 0;
  calMoved = false;
  calSum[0] = calSum[1] = calSum[2] = 0;
  mode = MODE_CAL;
  motorsOff();
  if (kind == CAL_GYRO)    report(F("Calibrating gyro: keep the robot still (2 s)..."));
  else if (kind == CAL_UP) report(F("Calibrating upright: hold the robot still at its balance point..."));
  else                     report(F("Calibrating forward: hold the robot tilted ~20 degrees forward..."));
}

void calStep(const int16_t* raw) {
  const int16_t* v = (calKind == CAL_GYRO) ? &raw[4] : &raw[0];
  const int16_t thr = (calKind == CAL_GYRO) ? 250 : 1200;  // ~3.8 °/s  |  ~0.15 g
  if (calN == 0) { calRef[0] = v[0]; calRef[1] = v[1]; calRef[2] = v[2]; }
  for (uint8_t i = 0; i < 3; i++) {
    if (abs((int32_t)v[i] - calRef[i]) > thr) calMoved = true;
    calSum[i] += v[i];
  }
  calN++;
  const uint16_t need = (calKind == CAL_GYRO) ? CAL_SAMPLES_GYRO : CAL_SAMPLES_ACC;
  if (calN < need) return;

  if (calMoved) {
    if (++calTries < 5) {
      report(F("Movement detected: retrying, keep the robot still"));
      calN = 0;
      calMoved = false;
      calSum[0] = calSum[1] = calSum[2] = 0;
      return;
    }
    report(F("Calibration failed: the robot was not still"));
    if (calKind == CAL_GYRO) {
      for (uint8_t i = 0; i < 3; i++) gBias[i] = P.gb[i];
      report(F("Using the saved gyro bias"));
    }
    mode = MODE_IDLE;
    return;
  }

  float m[3] = {calSum[0] / calN, calSum[1] / calN, calSum[2] / calN};
  if (calKind == CAL_GYRO) {
    for (uint8_t i = 0; i < 3; i++) { gBias[i] = m[i]; P.gb[i] = m[i]; }
    report(F("Gyro calibrated"));
  } else if (calKind == CAL_UP) {
    for (uint8_t i = 0; i < 3; i++) P.up[i] = m[i];
    P.trim = 0;
    updateAxes();
    angleInit = false;
    mode = MODE_IDLE;
    saveParams();
    report(F("Upright calibrated and saved. Next: calfwd (or 'on')"));
  } else {
    norm3(m);
    float upn[3] = {P.up[0], P.up[1], P.up[2]};
    norm3(upn);
    if (dot3(m, upn) > 0.985f) {   // less than ~10 degrees apart
      report(F("Not tilted enough: tilt about 20 degrees and repeat calfwd"));
    } else {
      for (uint8_t i = 0; i < 3; i++) P.fwd[i] = m[i];
      updateAxes();
      angleInit = false;
      mode = MODE_IDLE;
      saveParams();
      report(F("Forward direction calibrated and saved. Send 'on' to balance"));
    }
  }
  mode = MODE_IDLE;
}

// ---------------------------------------------------------------------
//  Autotune
//  While balancing, each set of gains is scored for 4 s with
//    J = rms(angle error) + 0.04·rms(ΔPWM) + 3·rms(vEst) + 5·saturation
//  (small error, no jitter, no drift, no saturation). One gain at a time is
//  moved up or down; changes that lower J by > 7 % are kept. A fall counts as
//  J = ∞. When no gain improves, the step is halved; below 6 % it stops.
// ---------------------------------------------------------------------
void reportGains(const char* prefix) {
  char b[72], s1[10], s2[10], s3[10];
  dtostrf(P.kp, 1, 1, s1);
  dtostrf(P.kd, 1, 2, s2);
  dtostrf(P.ks, 1, 1, s3);
  snprintf(b, sizeof(b), "%s kp=%s kd=%s ks=%s", prefix, s1, s2, s3);
  report(b);
}

void atApply(const float* v) { P.kp = v[0]; P.kd = v[1]; P.ks = v[2]; }

void atResetWindow() {
  atN = 0;
  atSE = atSDu = atSV = atSSat = 0;
  atSkip = AT_SKIP;
}

void atTrialValues(int8_t sign, float* v) {
  for (uint8_t i = 0; i < 3; i++) v[i] = atBase[i];
  float span = atBase[atPi] > 0.5f * AT_REF[atPi] ? atBase[atPi] : 0.5f * AT_REF[atPi];
  v[atPi] = constrain(atBase[atPi] + sign * atStep * span, AT_LO[atPi], AT_HI[atPi]);
}

void atStart() {
  atOrig[0] = P.kp; atOrig[1] = P.kd; atOrig[2] = P.ks;
  for (uint8_t i = 0; i < 3; i++) atBase[i] = atOrig[i];
  atStep = 0.25f; atPi = 0; atTrial = 0; atJbase = -1.0f;
  atImproved = false; atBaseFalls = 0; atRescue = 0;
  atResetWindow();
  atOn = true;
  report(F("Autotune ON: let it balance; stand it up again whenever it falls (~2-6 min)"));
}

void atFinish(bool ok) {
  atOn = false;
  if (ok) {
    atApply(atBase);
    reportGains("Autotune done:");
    report(F("Send 'off' and then 'save' to keep these gains"));
  } else {
    atApply(atOrig);
    report(F("Autotune gave up: check motor direction (mt), minpwm and battery"));
  }
}

void atNextParam() {
  atPi = (atPi + 1) % 3;
  if (atPi == 0) {
    if (!atImproved) {
      atStep *= 0.5f;
      if (atStep < 0.06f) { atFinish(true); return; }
    }
    atImproved = false;
    atTrial = 0;              // re-score the base at the start of each round
    atJbase = -1.0f;
    atApply(atBase);
    return;
  }
  float v[3];
  atTrialValues(+1, v);
  atTrial = 1;
  atApply(v);
}

void atEvaluate(float J) {
  if (atTrial == 0) {                         // scoring the current best gains
    if (isinf(J)) {
      if (++atBaseFalls >= 2) {               // they cannot balance: try a bolder set
        if (atRescue >= 4) { atFinish(false); return; }
        float f = AT_RESCUE[atRescue++];
        atBaseFalls = 0;
        atBase[0] = constrain(atOrig[0] * f, AT_LO[0], AT_HI[0]);
        atBase[1] = constrain(atOrig[1] * f, AT_LO[1], AT_HI[1]);
        atBase[2] = atOrig[2] > 15.0f ? atOrig[2] : 15.0f;
        atApply(atBase);
        reportGains("Autotune rescue:");
      }
      return;
    }
    atBaseFalls = 0;
    atJbase = J;
    float v[3];
    atTrialValues(+1, v);
    atTrial = 1;
    atApply(v);
    return;
  }
  if (!isinf(J) && J < atJbase * 0.93f) {     // this change helps: keep it
    atBase[0] = P.kp; atBase[1] = P.kd; atBase[2] = P.ks;
    atJbase = J;
    atImproved = true;
    reportGains("Autotune better:");
    atNextParam();
    return;
  }
  if (atTrial == 1) {                         // up did not help: try down
    float v[3];
    atTrialValues(-1, v);
    atTrial = 2;
    atApply(v);
    return;
  }
  atApply(atBase);
  atNextParam();
}

void atTick(float err, float u) {
  if (atSkip) { atSkip--; return; }
  float du = u - uOut;
  atN++;
  atSE += err * err;
  atSDu += du * du;
  atSV += vEst * vEst;
  if (fabsf(u) >= 250.0f) atSSat += 1.0f;
  if (atN >= AT_WIN) {
    float n = atN;
    float J = sqrtf(atSE / n) + 0.04f * sqrtf(atSDu / n) + 3.0f * sqrtf(atSV / n) + 5.0f * atSSat / n;
    atEvaluate(J);
    atResetWindow();
  }
}

// ---------------------------------------------------------------------
//  Loop modes
// ---------------------------------------------------------------------
void startRun() {
  iTerm = 0; vEst = 0; autoTrim = 0; uOut = 0;
  rateF = 0; driveSm = 0; turnSm = 0; armTicks = 0;
  runTicks = 0; satTicks = 0;
  fallen = false;
  mode = MODE_RUN;
  if (atOn) atResetWindow();
  report(F("Balancing"));
}

void idleStep() {
  motorsOff();
  uOut = 0;
  tgt = P.trim;
  if (motorsEnabled && imuOk && fabsf(angle - P.trim) < ARM_ANGLE) {
    if (++armTicks >= (uint16_t)((uint32_t)ARM_TIME_MS * LOOP_HZ / 1000)) startRun();
  } else {
    armTicks = 0;
  }
}

void runStep() {
  if (!motorsEnabled) {
    motorsOff();
    mode = MODE_IDLE;
    report(F("Motors disabled"));
    return;
  }
  if (fabsf(angle - P.trim) > FALL_ANGLE) {
    motorsOff();
    mode = MODE_IDLE;
    fallen = true;
    armTicks = 0;
    if (atOn) { atEvaluate(INFINITY); atResetWindow(); }
    report(F("Fallen: motors off. Stand it upright to resume"));
    return;
  }
  // Outer loop: speed estimated from the applied PWM (no encoders).
  // The estimate only means "speed" while the motors are not saturated, so it
  // is frozen at full PWM; the loop also fades in over SOFT_START_MS.
  if (fabsf(uOut) < SAT_PWM) vEst += (uOut / 255.0f - vEst) * DT / P.tauv;
  if (runTicks < 60000) runTicks++;
  float ramp = (float)runTicks / ((float)SOFT_START_MS * LOOP_HZ / 1000.0f);
  float ks = P.ks * (ramp < 1.0f ? ramp : 1.0f);
  float vErr = driveSm * P.vmax - vEst;
  autoTrim = constrain(autoTrim + P.kis * vErr * DT, -P.lean, P.lean);
  tgt = P.trim + constrain(autoTrim + ks * vErr, -P.lean, P.lean);

  // Inner loop: angle PID (D term uses the filtered gyro rate)
  float err = angle - tgt;
  iTerm = constrain(iTerm + P.ki * err * DT, -I_TERM_LIMIT, I_TERM_LIMIT);
  float u = P.kp * err + iTerm + P.kd * rateF;
  u = constrain(u, -255.0f, 255.0f);

  // Latch breaker: full power for LATCH_MS while nearly upright cannot happen
  // in free balancing (it would tip the robot over). It happens when the robot
  // is held by hand or the wheels are blocked: the PWM-based speed estimate
  // then feeds itself. Reset the outer loop so that, when released, the robot
  // starts from a clean state instead of being thrown at full power.
  if (fabsf(u) >= SAT_PWM && fabsf(angle - P.trim) < LATCH_ANGLE) {
    if (++satTicks >= (uint16_t)((uint32_t)LATCH_MS * LOOP_HZ / 1000)) {
      satTicks = 0;
      vEst = 0; autoTrim = 0; iTerm = 0;
      tgt = P.trim;
      err = angle - tgt;
      u = constrain(P.kp * err + P.kd * rateF, -255.0f, 255.0f);
    }
  } else {
    satTicks = 0;
  }
  if (atOn) atTick(err, u);
  uOut = u;

  float tr = turnSm * P.turn;
  motorL(frictionComp(u + tr));
  motorR(frictionComp(u - tr));
}

void motorTestStep() {
  const uint32_t T1 = LOOP_HZ * 8 / 10, T2 = LOOP_HZ * 12 / 10, T3 = LOOP_HZ * 2;
  uint32_t t = modeTicks++;
  if (t == 0)  report(F("Test: LEFT wheel FORWARD"));
  if (t == T2) report(F("Test: RIGHT wheel FORWARD"));
  if (t < T1)      { motorL(140); motorR(0); }
  else if (t < T2) { motorsOff(); }
  else if (t < T3) { motorL(0); motorR(140); }
  else {
    motorsOff();
    mode = MODE_IDLE;
    report(F("Test done. If a wheel spun backwards: invl / invr"));
  }
}

void rampStep() {
  if (rampOkReq) {
    rampOkReq = false;
    motorsOff();
    P.minpwm = rampPwm + 2;
    char b[64];
    snprintf(b, sizeof(b), "minpwm = %d (use 'save' to store it)", rampPwm + 2);
    report(b);
    mode = MODE_IDLE;
    return;
  }
  if (modeTicks % (LOOP_HZ * 15 / 100) == 0) {   // +1 PWM every 150 ms
    rampPwm++;
    if (rampPwm > 150) {
      motorsOff();
      mode = MODE_IDLE;
      report(F("Ramp finished without 'ok'. Check motors and battery"));
      return;
    }
    if (rampPwm % 5 == 0) {
      char b[24];
      snprintf(b, sizeof(b), "PWM %d", rampPwm);
      report(b);
    }
  }
  modeTicks++;
  motorL(rampPwm);
  motorR(rampPwm);
}

void applyModeRequest(uint8_t r) {
  motorsOff();
  modeTicks = 0;
  switch (r) {
    case MODE_CAL:   startCal(reqCal); break;
    case MODE_MTEST: mode = MODE_MTEST; break;
    case MODE_RAMP:  rampPwm = 4; rampOkReq = false; mode = MODE_RAMP; break;
    default:         mode = MODE_IDLE; break;
  }
}

// Lists the devices on the I2C bus (wiring diagnostics)
void i2cScanReport() {
  char b[72];
  int len = snprintf(b, sizeof(b), "I2C devices found:");
  uint8_t n = 0;
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      if (len < 60) len += snprintf(b + len, sizeof(b) - len, " 0x%02X", a);
      n++;
    }
  }
  if (n == 0) snprintf(b + len, sizeof(b) - len, " none (check SDA/SCL/VCC/GND)");
  report(b);
}

// ---------------------------------------------------------------------
//  Control step (200 Hz)
// ---------------------------------------------------------------------
void controlStep() {
  uint32_t t0 = micros();

  if (reqMode != NO_REQ) {
    uint8_t r = reqMode;
    reqMode = NO_REQ;
    applyModeRequest(r);
  }
  if (reqScan) {
    reqScan = false;
    if (mode != MODE_RUN) i2cScanReport();
  }
  if (atReqStart) { atReqStart = false; if (!atOn) atStart(); }
  if (atReqStop) {
    atReqStop = false;
    if (atOn) { atOn = false; atApply(atBase); reportGains("Autotune stopped, best so far:"); }
  }

  // Without a working IMU: motors off and retry once per second (instead of
  // 200 times per second) so a missing sensor never stalls the loop.
  if (!imuOk) {
    motorsOff();
    if (mode != MODE_IDLE) mode = MODE_IDLE;
    if (++imuRetryTicks >= LOOP_HZ) {
      imuRetryTicks = 0;
      if (imu.begin(MPU_DLPF_CFG)) {
        imuOk = true;
        i2cErrors = 0;
        angleInit = false;
        report(F("MPU6050 detected"));
        startCal(CAL_GYRO);
      }
    }
    loopUs = micros() - t0;
    return;
  }

  int16_t raw[7];
  if (!imu.read(raw)) {
    if (++i2cErrors >= 10) {
      motorsOff();
      mode = MODE_IDLE;
      imuOk = false;
      imuRetryTicks = 0;
      report(F("ERROR: the MPU6050 stopped responding (check SDA/SCL/VCC/GND)"));
    }
    return;
  }
  i2cErrors = 0;

  if (mode == MODE_CAL) {
    motorsOff();
    calStep(raw);
    loopUs = micros() - t0;
    return;
  }

  // 1) Angle from the complementary filter
  float a[3] = {(float)raw[0], (float)raw[1], (float)raw[2]};
  float g[3] = {raw[4] - gBias[0], raw[5] - gBias[1], raw[6] - gBias[2]};
  float accAngle = atan2f(dot3(a, P.fwd), dot3(a, P.up)) * RAD_TO_DEG;
  rate = dot3(g, pitchAxis) / GYRO_LSB_PER_DPS;
  if (!angleInit) {
    angle = accAngle;
    rateF = 0;
    angleInit = true;
  } else {
    angle = P.alpha * (angle + rate * DT) + (1.0f - P.alpha) * accAngle;
  }
  rateF = P.dlpf * rateF + (1.0f - P.dlpf) * rate;

  // 2) Drive command (with watchdog and slew limit)
  float dc = driveCmd, tc = turnCmd;
  if (atOn || millis() - lastCmdMs > CMD_TIMEOUT_MS) { dc = 0; tc = 0; }  // no driving while autotuning
  driveSm += constrain(dc - driveSm, -DRIVE_SLEW * DT, DRIVE_SLEW * DT);
  turnSm  += constrain(tc - turnSm,  -TURN_SLEW * DT,  TURN_SLEW * DT);

  switch (mode) {
    case MODE_RUN:   runStep(); break;
    case MODE_MTEST: motorTestStep(); break;
    case MODE_RAMP:  rampStep(); break;
    default:         idleStep(); break;
  }
  loopUs = micros() - t0;
}

// ---------------------------------------------------------------------
//  Commands (the Serial Monitor at 115200 and the WiFi app share them)
// ---------------------------------------------------------------------
const char* modeName(uint8_t m) {
  switch (m) {
    case MODE_RUN:   return "balancing";
    case MODE_CAL:   return "calibrating";
    case MODE_MTEST: return "motor-test";
    case MODE_RAMP:  return "ramp";
    default:         return fallen ? "fallen" : "idle";
  }
}

void printHelp(Print& out) {
  out.println(F("--- Commands (Serial Monitor 115200, line ending: Newline) ---"));
  out.println(F(" get                 show parameters        info  current status"));
  out.println(F(" kp 45 | ki 0 | kd 0.6 | trim 0.3 | ks 20 | kis 1 ...  change live"));
  out.println(F(" on / off            enable / disable balancing"));
  out.println(F(" save | load | reset save / reload / default PID values"));
  out.println(F(" calg                calibrate gyro (keep still)"));
  out.println(F(" calup               calibrate upright (hold at balance point)"));
  out.println(F(" calfwd              calibrate forward (tilt ~20 degrees)"));
  out.println(F(" mt                  motor test (wheels off the ground)"));
  out.println(F(" ramp / ok           measure minimum PWM / 'ok' when they turn"));
  out.println(F(" invl | invr         reverse left / right motor direction"));
  out.println(F(" tel 1 | tel 0       telemetry for the Serial Plotter"));
  out.println(F(" d 0.5 0             drive: forward -1..1, turn -1..1 (0.6 s)"));
  out.println(F(" stop                cancel calibration or test"));
  out.println(F(" i2c                 scan the I2C bus (wiring check)"));
  out.println(F(" autotune [stop]     self-tune kp, kd, ks while it balances"));
}

void printParams(Print& out) {
  for (uint8_t i = 0; i < N_PDEF; i++) {
    out.print(PDEF[i].name);
    out.print('=');
    out.print(*PDEF[i].ptr, 4);
    out.print(i % 4 == 3 ? '\n' : ' ');
  }
  out.print(F("\ninvl="));
  out.print(P.invL);
  out.print(F(" invr="));
  out.println(P.invR);
}

void printInfo(Print& out) {
  out.print(F("mode="));      out.print(modeName(mode));
  out.print(F(" balance="));  out.print(motorsEnabled ? F("on") : F("off"));
  out.print(F(" imu="));      out.print(imuOk ? F("ok") : F("ERROR"));
  out.print(F(" autotune="));  out.print(atOn ? F("on") : F("off"));
  out.print(F(" angle="));    out.print(angle, 2);
  out.print(F(" target="));   out.print(tgt, 2);
  out.print(F(" rate="));     out.print(rate, 1);
  out.print(F(" pwm="));      out.print(uOut, 0);
  out.print(F(" loop_us="));  out.println(loopUs);
#if HAS_WIFI
  out.print(F("WiFi: network '")); out.print(apSsid);
  out.print(F("' password '"));     out.print(AP_PASSWORD);
  out.println(F("' -> http://192.168.4.1"));
  out.print(F("WiFi AP: ")); out.print(apStarted ? F("running") : F("FAILED"));
  out.print(F(" mode="));    out.print((int)WiFi.getMode());
  out.print(F(" ip="));      out.print(WiFi.softAPIP());
  out.print(F(" channel=")); out.print(WiFi.channel());
  out.print(F(" clients=")); out.println(WiFi.softAPgetStationNum());
#endif
}

void requestTest(uint8_t m, Print& out) {
  motorsEnabled = false;   // it will not start on its own afterwards: send 'on'
  if (m == MODE_CAL) out.println(F("Calibration started (balancing disabled: send 'on' afterwards)"));
  reqMode = m;
}

void handleCommand(char* line, Print& out) {
  for (char* p = line; *p; p++) *p = tolower(*p);
  char* cmd = strtok(line, " \t\r\n=:");
  if (!cmd) return;
  char* a1 = strtok(NULL, " \t\r\n=:,");
  char* a2 = strtok(NULL, " \t\r\n=:,");

  if (!strcmp(cmd, "help") || !strcmp(cmd, "?")) { printHelp(out); return; }
  if (!strcmp(cmd, "get"))  { printParams(out); return; }
  if (!strcmp(cmd, "info")) { printInfo(out); return; }
  if (!strcmp(cmd, "on"))   { motorsEnabled = true;  out.println(F("Balancing enabled: stand it upright")); return; }
  if (!strcmp(cmd, "off"))  {
    motorsEnabled = false;
    if (atOn) atReqStop = true;
    out.println(F("Balancing disabled"));
    return;
  }
  if (!strcmp(cmd, "autotune") || !strcmp(cmd, "at")) {
    if (a1 && (!strcmp(a1, "stop") || !strcmp(a1, "off") || !strcmp(a1, "0"))) {
      atReqStop = true;
      out.println(F("Stopping autotune"));
    } else {
      motorsEnabled = true;
      atReqStart = true;
      out.println(F("Autotune starting: stand the robot upright and let go"));
    }
    return;
  }
  if (!strcmp(cmd, "tel")) {
    telemetryOn = a1 ? (atoi(a1) != 0) : !telemetryOn;
    out.println(telemetryOn ? F("Telemetry ON") : F("Telemetry OFF"));
    return;
  }
  if (!strcmp(cmd, "save")) {
    out.println(saveParams() ? F("Saved") : F("Cannot save while balancing: send 'off' first"));
    return;
  }
  if (!strcmp(cmd, "load") || !strcmp(cmd, "reset")) {
    if (mode == MODE_RUN) { out.println(F("Send 'off' first")); return; }
    if (cmd[0] == 'l') { loadParams(); out.println(F("Parameters reloaded from memory")); }
    else { setDefaultTuning(); out.println(F("Default PID values (calibration kept, not saved)")); }
    return;
  }
  if (!strcmp(cmd, "calg"))   { reqCal = CAL_GYRO; requestTest(MODE_CAL, out); return; }
  if (!strcmp(cmd, "calup"))  { reqCal = CAL_UP;   requestTest(MODE_CAL, out); return; }
  if (!strcmp(cmd, "calfwd")) { reqCal = CAL_FWD;  requestTest(MODE_CAL, out); return; }
  if (!strcmp(cmd, "mt")) {
    requestTest(MODE_MTEST, out);
    out.println(F("Motor test: lift the wheels off the ground"));
    return;
  }
  if (!strcmp(cmd, "ramp")) {
    requestTest(MODE_RAMP, out);
    out.println(F("Ramp: hold the robot upright on the floor and send 'ok' when the wheels start turning"));
    return;
  }
  if (!strcmp(cmd, "ok"))   { if (mode == MODE_RAMP) rampOkReq = true; return; }
  if (!strcmp(cmd, "i2c"))  { reqScan = true; return; }
#if HAS_WIFI
  if (!strcmp(cmd, "wifi")) {   // radio check: TX power and networks the robot can hear
    if (WiFi.getMode() != WIFI_AP_STA) WiFi.mode(WIFI_AP_STA);
    out.print(F("TX power (x0.25 dBm): ")); out.println((int)WiFi.getTxPower());
    int n = WiFi.scanNetworks();
    out.print(F("Networks heard by the robot: ")); out.println(n);
    for (int i = 0; i < n && i < 6; i++) {
      out.print(F("  ")); out.print(WiFi.SSID(i));
      out.print(F("  ")); out.print(WiFi.RSSI(i));
      out.print(F(" dBm  ch")); out.println(WiFi.channel(i));
    }
    WiFi.scanDelete();
    return;
  }
#endif
  if (!strcmp(cmd, "stop")) { reqMode = MODE_IDLE; out.println(F("Stopped")); return; }
  if (!strcmp(cmd, "invl")) { P.invL = !P.invL; out.print(F("invl=")); out.println(P.invL); return; }
  if (!strcmp(cmd, "invr")) { P.invR = !P.invR; out.print(F("invr=")); out.println(P.invR); return; }
  if (!strcmp(cmd, "d")) {
    driveCmd = a1 ? constrain((float)atof(a1), -1.0f, 1.0f) : 0.0f;
    turnCmd  = a2 ? constrain((float)atof(a2), -1.0f, 1.0f) : 0.0f;
    lastCmdMs = millis();
    return;
  }
  for (uint8_t i = 0; i < N_PDEF; i++) {
    if (!strcmp(cmd, PDEF[i].name)) {
      if (a1) {
        float v = atof(a1);
        if (v < PDEF[i].lo || v > PDEF[i].hi) {
          out.print(F("Out of range: "));
          out.print(PDEF[i].lo, 3);
          out.print(F(" .. "));
          out.println(PDEF[i].hi, 3);
          return;
        }
        if (atOn && (PDEF[i].ptr == &P.kp || PDEF[i].ptr == &P.kd || PDEF[i].ptr == &P.ks)) {
          atOn = false;
          out.println(F("Autotune stopped (manual change)"));
        }
        *PDEF[i].ptr = v;
      }
      out.print(PDEF[i].name);
      out.print('=');
      out.println(*PDEF[i].ptr, 4);
      return;
    }
  }
  out.print(F("Unknown command: "));
  out.print(cmd);
  out.println(F("  (type help)"));
}

void serviceSerial() {
  static char buf[48];
  static uint8_t n = 0;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (n) { buf[n] = 0; handleCommand(buf, Serial); n = 0; }
    } else if (n < sizeof(buf) - 1) {
      buf[n++] = c;
    }
  }
}

// "label:value" format for the Arduino IDE Serial Plotter
void serviceTelemetry() {
  static uint32_t last = 0;
  if (!telemetryOn || millis() - last < 40) return;
  last = millis();
  Serial.print(F("angle:"));    Serial.print(angle, 2);
  Serial.print(F(",target:"));  Serial.print(tgt, 2);
  Serial.print(F(",vel_x10:")); Serial.print(vEst * 10.0f, 2);
  Serial.print(F(",pwm_10:"));  Serial.println(uOut / 10.0f, 1);
}

void serviceLed() {
  uint32_t ms = millis();
  bool on;
  if (!imuOk)                  on = (ms / 60) % 2;
  else if (mode == MODE_RUN)   on = true;
  else if (mode != MODE_IDLE)  on = (ms / 120) % 2;
  else if (fallen)             on = (ms / 500) % 2;
  else                         on = false;
  digitalWrite(LED_BUILTIN, on ? HIGH : LOW);
}

// ---------------------------------------------------------------------
//  WiFi + web app (Nano ESP32 only)
// ---------------------------------------------------------------------
#if HAS_WIFI
class StrPrint : public Print {
 public:
  String s;
  size_t write(uint8_t c) override { s += (char)c; return 1; }
};

String telemetryJson() {
  uint16_t h = msgHead;
  const char* lastMsg = h ? msgRing[(h - 1) % MSG_SLOTS] : "";
  char b[300];
  snprintf(b, sizeof(b),
           "{\"a\":%.2f,\"t\":%.2f,\"r\":%.1f,\"u\":%.1f,\"v\":%.3f,\"at\":%.2f,"
           "\"m\":\"%s\",\"e\":%d,\"imu\":%d,\"tune\":%d,\"rp\":%d,\"lu\":%u,\"sq\":%u,\"msg\":\"%s\"}",
           angle, tgt, rate, uOut, vEst, autoTrim, modeName(mode), motorsEnabled ? 1 : 0,
           imuOk ? 1 : 0, atOn ? 1 : 0, rampPwm, (unsigned)loopUs, (unsigned)h, lastMsg);
  return String(b);
}

void handleRoot() { server.send_P(200, "text/html", WEB_PAGE); }

void handleJoy() {
  if (server.hasArg("v")) driveCmd = constrain(server.arg("v").toFloat(), -1.0f, 1.0f);
  if (server.hasArg("t")) turnCmd  = constrain(server.arg("t").toFloat(), -1.0f, 1.0f);
  lastCmdMs = millis();
  server.send(200, "application/json", telemetryJson());
}

void handleCmd() {
  char buf[64];
  server.arg("q").toCharArray(buf, sizeof(buf));
  StrPrint sp;
  handleCommand(buf, sp);
  server.send(200, "text/plain", sp.s);
}

void handleState() {
  String s = "{\"fw\":\"" FW_VERSION "\",\"ssid\":\"";
  s += apSsid;
  s += "\",\"p\":{";
  for (uint8_t i = 0; i < N_PDEF; i++) {
    if (i) s += ',';
    s += '"'; s += PDEF[i].name; s += "\":";
    s += String(*PDEF[i].ptr, 4);
  }
  s += ",\"invl\":"; s += P.invL;
  s += ",\"invr\":"; s += P.invR;
  s += "},\"tel\":";
  s += telemetryJson();
  s += '}';
  server.send(200, "application/json", s);
}

void wifiSetup() {
  WiFi.mode(WIFI_AP);
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);   // unique per board (read from eFuse)
  snprintf(apSsid, sizeof(apSsid), "%s-%02X%02X", AP_SSID_PREFIX, mac[4], mac[5]);
  apStarted = WiFi.softAP(apSsid, AP_PASSWORD, AP_CHANNEL);
  WiFi.setSleep(false);
  server.on("/", handleRoot);
  server.on("/j", handleJoy);
  server.on("/c", handleCmd);
  server.on("/s", handleState);
  server.onNotFound([]() { server.send(404, "text/plain", "not found"); });
  server.begin();
  if (!apStarted) report(F("ERROR: the WiFi access point did not start"));
  Serial.printf("WiFi: join '%s' (password '%s') and open http://%s\n", apSsid, AP_PASSWORD,
                WiFi.softAPIP().toString().c_str());
}

void controlTask(void*) {
  TickType_t last = xTaskGetTickCount();
  const TickType_t period = pdMS_TO_TICKS(1000 / LOOP_HZ);
  for (;;) {
    vTaskDelayUntil(&last, period);
    controlStep();
  }
}

void printQueuedMessages() {
  while (msgPrinted != msgHead) {
    if ((uint16_t)(msgHead - msgPrinted) > MSG_SLOTS) msgPrinted = msgHead - MSG_SLOTS;
    Serial.println(msgRing[msgPrinted % MSG_SLOTS]);
    msgPrinted++;
  }
}
#endif

// ---------------------------------------------------------------------
//  setup / loop
// ---------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  pinMode(PIN_ENA, OUTPUT); pinMode(PIN_IN1, OUTPUT); pinMode(PIN_IN2, OUTPUT);
  pinMode(PIN_ENB, OUTPUT); pinMode(PIN_IN3, OUTPUT); pinMode(PIN_IN4, OUTPUT);
  pinMode(PIN_MPU_INT, INPUT);
  pinMode(LED_BUILTIN, OUTPUT);

#if HAS_WIFI
  #if defined(ARDUINO_USB_MODE) && (ARDUINO_USB_MODE == 0) && ARDUINO_USB_CDC_ON_BOOT
  // A serial terminal toggling DTR/RTS must never reboot the robot into the
  // ROM bootloader while it balances. Uploads use DFU, which does not need this.
  Serial.enableReboot(false);
  #endif
  EEPROM.begin(256);
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 1500) delay(10);   // short wait for USB
#endif

  loadParams();
  motorsOff();

  Wire.begin();
  Wire.setClock(400000);
#if HAS_WIFI
  Wire.setTimeOut(5);                // ms: a bad I2C bus cannot stall the loop
#else
  Wire.setWireTimeout(3000, true);   // µs: a loose wire cannot hang the Nano
#endif

  Serial.println();
  Serial.println(F("=== Self-balancing robot v" FW_VERSION " === (type help)"));

  for (uint8_t i = 0; i < 3; i++) gBias[i] = P.gb[i];
  if (imu.begin(MPU_DLPF_CFG)) {
    imuOk = true;
    Serial.print(F("MPU6050 at 0x"));
    Serial.print(imu.addr, HEX);
    Serial.print(F(", WHO_AM_I=0x"));
    Serial.println(imu.whoAmI(), HEX);
    startCal(CAL_GYRO);
  } else {
    imuOk = false;
    report(F("ERROR: MPU6050 not found. Check SDA=A4, SCL=A5, VCC and GND (retrying every 1 s)"));
    i2cScanReport();
  }

#if HAS_WIFI
  wifiSetup();
  // Control loop on core 1 with a higher priority than loop() (WiFi/serial)
  xTaskCreatePinnedToCore(controlTask, "control", 4096, NULL, 3, NULL, 1);
#else
  nextTick = micros();
#endif
}

void loop() {
#if HAS_WIFI
  server.handleClient();
  serviceSerial();
  printQueuedMessages();
  serviceTelemetry();
  serviceLed();
  delay(1);
#else
  uint32_t now = micros();
  if ((int32_t)(now - nextTick) >= 0) {
    nextTick += DT_US;
    if ((int32_t)(now - nextTick) > (int32_t)(4 * DT_US)) nextTick = now + DT_US;  // resync
    controlStep();
  }
  serviceSerial();
  serviceTelemetry();
  serviceLed();
#endif
}
