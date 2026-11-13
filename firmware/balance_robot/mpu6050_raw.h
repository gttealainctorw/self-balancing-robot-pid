// =====================================================================
//  mpu6050_raw.h — Minimal register-level MPU6050 driver (no libraries)
// =====================================================================
#pragma once
#include <Arduino.h>
#include <Wire.h>

class MPU6050Raw {
 public:
  uint8_t addr = 0x68;

  // Looks for the sensor at 0x68 (AD0 low / unconnected) or 0x69 (AD0 high)
  bool begin(uint8_t dlpfCfg) {
    const uint8_t candidates[2] = {0x68, 0x69};
    bool found = false;
    for (uint8_t i = 0; i < 2 && !found; i++) {
      Wire.beginTransmission(candidates[i]);
      if (Wire.endTransmission() == 0) { addr = candidates[i]; found = true; }
    }
    if (!found) return false;
    writeReg(0x6B, 0x80);            // PWR_MGMT_1: reset
    delay(100);
    writeReg(0x6B, 0x01);            // clock = X gyro PLL
    delay(10);
    writeReg(0x19, 0x00);            // SMPLRT_DIV: 1 kHz
    writeReg(0x1A, dlpfCfg & 0x07);  // CONFIG: internal low-pass filter
    writeReg(0x1B, 0x08);            // GYRO_CONFIG: ±500 °/s
    writeReg(0x1C, 0x08);            // ACCEL_CONFIG: ±4 g
    delay(20);
    return true;
  }

  uint8_t whoAmI() { return readReg(0x75); }

  // d[0..2] = accelerometer XYZ, d[3] = temperature, d[4..6] = gyro XYZ
  bool read(int16_t* d) {
    Wire.beginTransmission(addr);
    Wire.write(0x3B);
    if (Wire.endTransmission(false) != 0) return false;
    if (Wire.requestFrom((int)addr, (int)14) != 14) return false;
    for (uint8_t i = 0; i < 7; i++) {
      uint8_t hi = Wire.read();
      uint8_t lo = Wire.read();
      d[i] = (int16_t)(((uint16_t)hi << 8) | lo);
    }
    return true;
  }

 private:
  bool writeReg(uint8_t reg, uint8_t val) {
    Wire.beginTransmission(addr);
    Wire.write(reg);
    Wire.write(val);
    return Wire.endTransmission() == 0;
  }
  uint8_t readReg(uint8_t reg) {
    Wire.beginTransmission(addr);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return 0xFF;
    if (Wire.requestFrom((int)addr, (int)1) != 1) return 0xFF;
    return Wire.read();
  }
};
