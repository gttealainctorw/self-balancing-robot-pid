// Required libraries for robot control
#include <PID_v1.h>
#include <LMotorController.h>
#include "I2Cdev.h"
#include "MPU6050_6Axis_MotionApps20.h"

#if I2CDEV_IMPLEMENTATION == I2CDEV_ARDUINO_WIRE
#include "Wire.h"
#endif

#define MIN_ABS_SPEED 30
MPU6050 mpu;

//************* Settings *************
double LeftMotorSpeed  = 0.7;
double RightMotorSpeed = 0.6;
double BalancePoint    = 180;

//-----------------Motor Control
int ENA = 5;
int IN1 = 7;
int IN2 = 6;
int IN3 = 8;
int IN4 = 9;
int ENB = 10;

//------------------PID Values
double Kp = 60;
double Kd = 2.5;
double Ki = 270;

//*****************************
bool     dmpReady   = false;
uint8_t  mpuIntStatus;
uint8_t  devStatus;
uint16_t packetSize;
uint16_t fifoCount;
uint8_t  fifoBuffer[64];

Quaternion  q;
VectorFloat gravity;
float       ypr[3];

double originalSetpoint = BalancePoint;
double setpoint = originalSetpoint;
double input, output;

PID pid(&input, &output, &setpoint, Kp, Ki, Kd, DIRECT);
LMotorController motorController(ENA, IN1, IN2, ENB, IN3, IN4, LeftMotorSpeed, RightMotorSpeed);

volatile bool mpuInterrupt = false;

void dmpDataReady() {
    mpuInterrupt = true;
}

void setup() {
    Serial.begin(11200);

    #if I2CDEV_IMPLEMENTATION == I2CDEV_ARDUINO_WIRE
    Wire.begin();
    TWBR = 24; // I2C clock at 400kHz
    #endif

    mpu.initialize();

    // Verify MPU6050 connection before continuing
    if (!mpu.testConnection()) {
        Serial.println(F("MPU6050 connection failed. Check wiring."));
        while (true); // Halt program if sensor is not found
    }
    Serial.println(F("MPU6050 connection successful."));

    devStatus = mpu.dmpInitialize();

    // Manual gyroscope offsets
    mpu.setXGyroOffset(87);
    mpu.setYGyroOffset(199);
    mpu.setZGyroOffset(0);
    mpu.setZAccelOffset(1028);

    if (devStatus == 0) {
        mpu.setDMPEnabled(true);
        attachInterrupt(0, dmpDataReady, RISING);
        mpuIntStatus = mpu.getIntStatus();
        dmpReady   = true;
        packetSize = mpu.dmpGetFIFOPacketSize();

        pid.SetMode(AUTOMATIC);
        pid.SetSampleTime(10);
        pid.SetOutputLimits(-255, 255);
    } else {
        Serial.print(F("DMP Initialization failed (code "));
        Serial.print(devStatus);
        Serial.println(F(")"));
    }
}

void loop() {
    if (!dmpReady) return;

    while (!mpuInterrupt && fifoCount < packetSize) {
        pid.Compute();
        motorController.move(output, MIN_ABS_SPEED);
    }

    mpuInterrupt  = false;
    mpuIntStatus  = mpu.getIntStatus();
    fifoCount     = mpu.getFIFOCount();

    if ((mpuIntStatus & 0x10) || fifoCount == 1024) {
        mpu.resetFIFO();
        Serial.println(F("FIFO overflow!"));
    } else if (mpuIntStatus & 0x02) {
        while (fifoCount < packetSize) fifoCount = mpu.getFIFOCount();
        mpu.getFIFOBytes(fifoBuffer, packetSize);

        mpu.dmpGetQuaternion(&q, fifoBuffer);
        mpu.dmpGetGravity(&gravity, &q);
        mpu.dmpGetYawPitchRoll(ypr, &q, &gravity);

        input = ypr[1] * 180/M_PI + 180;
    }
}
