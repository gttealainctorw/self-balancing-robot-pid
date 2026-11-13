function [p, c] = robot_params()
%ROBOT_PARAMS  Physical (p) and controller (c) parameters.
%
%   [p, c] = robot_params()
%
%   Replace the values in "p" with those of YOUR robot (see matlab/README.md,
%   "Measuring the parameters"). The values in "c" are the same as the
%   firmware's config.h: if you find better gains here, set them on the robot
%   with the app or the Serial Monitor (e.g. "kp 50").

% ------------------------------------------------------------------
%  Physical (typical values: 3-deck chassis, TT motors, 2x18650)
% ------------------------------------------------------------------
p.g        = 9.81;     % gravity (m/s^2)
p.M        = 0.55;     % body mass WITHOUT wheels: chassis+battery+boards+motors (kg)
p.m        = 0.06;     % mass of BOTH wheels (kg)
p.r        = 0.0325;   % wheel radius (m)  -> 65 mm wheel
p.l        = 0.07;     % height of the body centre of mass above the wheel axle (m)
p.Ib       = 0.0015;   % body inertia about its centre of mass (kg m^2)
p.J_rotor  = 2.8e-4;   % inertia of both rotors seen at the wheel (J_motor*N^2) (kg m^2)
p.h_imu    = 0.05;     % height of the MPU6050 above the wheel axle (m)

% Total "wheel" inertia (wheels as discs + reflected rotors)
p.Iw_total = 2*0.5*(p.m/2)*p.r^2 + p.J_rotor;

% ------------------------------------------------------------------
%  Motors (PER MOTOR, measured at the wheel shaft, gearbox included)
%  Yellow TT 1:48 motor: ~200 rpm no-load and ~0.8 kg*cm stall at 6 V
% ------------------------------------------------------------------
p.V_nom    = 6;                    % datasheet voltage (V)
p.T_stall  = 0.078;                % stall torque at V_nom (N m)
p.w_noload = 200*2*pi/60;          % no-load speed at V_nom (rad/s)
p.k_tau    = p.T_stall/p.V_nom;    % torque per volt at standstill (N m/V)
p.k_b      = p.V_nom/p.w_noload;   % back-EMF constant (V s/rad)
p.tau_c    = 0.008;                % dry friction of the gearbox (N m)
p.eps_f    = 0.1;                  % numerical smoothing of the friction (rad/s)

% ------------------------------------------------------------------
%  Electronics and sensor
% ------------------------------------------------------------------
p.Vbat          = 7.4;   % battery (V): 2S = 7.4, 3S = 11.1
p.Vdrop         = 2.0;   % L298N voltage drop (V)
p.fc_mpu        = 42;    % MPU6050 internal filter with MPU_DLPF_CFG = 3 (Hz)
p.noise_acc_deg = 0.3;   % accelerometer angle noise (deg)
p.noise_gyro    = 0.15;  % gyro noise (deg/s)
p.bias_gyro     = 0.8;   % residual gyro error after calibration (deg/s)

% ------------------------------------------------------------------
%  Controller: SAME names and values as firmware/balance_robot/config.h
% ------------------------------------------------------------------
c.LOOP_HZ      = 200;   % loop rate (Hz)
c.FALL_ANGLE   = 40;    % fall cut-off (deg)
c.ARM_ANGLE    = 3;     % automatic start (deg)
c.I_TERM_LIMIT = 120;   % anti-windup (PWM)
c.DRIVE_SLEW   = 1.5;   % slew rate of the drive command (1/s)
c.TURN_SLEW    = 4;     % slew rate of the turn command (1/s)

c.kp     = 45;     % PWM / deg
c.ki     = 0;      % PWM / (deg s)
c.kd     = 0.6;    % PWM / (deg/s)
c.dlpf   = 0.5;    % D-term smoothing
c.trim   = 0;      % balance point (deg)
c.ks     = 20;     % speed loop: deg per unit of speed
c.kis    = 0;      % speed-loop integral (auto-trim)
c.vmax   = 0.35;   % speed requested at full joystick (fraction of PWM)
c.tauv   = 0.20;   % speed estimator time constant (s)
c.lean   = 10;     % max lean requested by the speed loop (deg)
c.minpwm = 28;     % lowest PWM that turns the wheels
c.db     = 2;      % output dead band (PWM)
c.turn   = 60;     % differential PWM at full turn
c.alpha  = 0.99;   % complementary filter
end
