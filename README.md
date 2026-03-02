# Self-Balancing Robot

Controls a two-wheeled self-balancing robot using an MPU6050 IMU and a PID controller.

---

## Hardware
- Arduino (Uno/Nano)
- MPU6050 (gyroscope + accelerometer)
- L298N motor driver (or equivalent)
- 2 DC motors

---

## Tunable Parameters
| Parameter | Variable | Default |
|---|---|---|
| Balance point (degrees) | `BalancePoint` | 180 |
| Left motor factor | `LeftMotorSpeed` | 0.7 |
| Right motor factor | `RightMotorSpeed` | 0.6 |
| PID – Proportional | `Kp` | 60 |
| PID – Integral | `Ki` | 270 |
| PID – Derivative | `Kd` | 2.5 |

---

## Required Libraries

### LMotorController
Use this specific version: **https://github.com/gttealainctorw/LMotorController/tree/main**

This is the one designed specifically for PID balancing robots and is fully compatible with this code.

**How to install:**
1. Go to the GitHub link above
2. Click Code → Download ZIP
3. In Arduino IDE: Sketch → Include Library → Add .ZIP Library
4. Select the downloaded ZIP

> ⚠️ Other versions of LMotorController on GitHub have different method names and parameters — they will cause compilation errors with this code.

### Other Libraries
These are part of the i2cdevlib collection: https://github.com/jrowberg/i2cdevlib
- **I2Cdev**
- **MPU6050** (MPU6050_6Axis_MotionApps20)

**How to install:**
1. Go to the GitHub link above
2. Download the full repo as ZIP
3. Copy the `I2Cdev` and `MPU6050` folders into your Arduino libraries folder

### PID_v1
Available directly in the Arduino Library Manager:
1. In Arduino IDE: Sketch → Include Library → Manage Libraries
2. Search for `PID` by Brett Beauregard
3. Install

---
## MPU6050 Calibration

Before running the PID controller, the **MPU6050 must be calibrated** to obtain accurate sensor offsets.  
This project uses the calibration method from:

https://github.com/gttealainctorw/MPU6050-Calibration-Module

### Steps

1. Connect the MPU6050 to the Arduino.
2. Place the sensor on a flat, stable surface.
3. Upload the calibration sketch from the repository above.
4. Open the Serial Monitor and wait for calibration to finish.
5. Copy the generated offsets into this project.

> Calibration is required only once unless the sensor or hardware setup changes.
## First Run
Open the Serial Monitor at **11200 baudios**. You should see:
```
MPU6050 connection successful.
```
If you see `MPU6050 connection failed. Check wiring.` — verify your I2C wiring (SDA, SCL) and that the sensor is powered correctly.

---

## Notes
- The gyroscope offsets in the code are specific to the original sensor. If your robot doesn't balance correctly, you may need to recalibrate them using the i2cdevlib calibration tool. 
- `BalancePoint = 180` depends on how the sensor is physically mounted on the robot.
- PID values may need tuning depending on your robot's weight, motors, and wheels.
