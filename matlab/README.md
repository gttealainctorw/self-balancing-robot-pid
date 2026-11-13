# MATLAB simulation

A nonlinear model of the robot driven by **the same controller as the firmware**, line by line.
Use it to try gains before uploading them to the robot, and to understand why the controller is designed this way.
It only needs base MATLAB. With the Control System Toolbox, `linear_analysis.m` also compares against an LQR.

[![Open in MATLAB Online](https://www.mathworks.com/images/responsive/global/open-in-matlab-online.svg)](https://matlab.mathworks.com/open/github/v1?repo=gttealainctorw/self-balancing-robot-pid&file=matlab/simulate_robot.m)

| File | What it does |
|---|---|
| `robot_params.m` | **Edit here** your robot's measurements (`p`) and the gains (`c`, same as `config.h`) |
| `simulate_robot.m` | **Run this one.** Releases the robot tilted, pushes it and drives it with the "joystick". Plots and animates the result |
| `linear_analysis.m` | Poles, kp–kd and ks–tauv stability maps, comparison with LQR |
| `robot_dynamics.m` | Equations of motion (Lagrange) + DC motor + gearbox friction |
| `controller_step.m` | Copy of `controlStep()` / `runStep()` from `balance_robot.ino` |
| `controller_init.m` | Initial controller state |
| `linear_model.m`, `closed_loop_linear.m` | Linearization and closed loop for the analysis |
| `animate_robot.m` | 2D animation |

```matlab
>> cd matlab
>> simulate_robot     % full simulation + plots + animation
>> linear_analysis    % stability maps
```

## The model

States: `x` (position), `v`, `θ` (tilt, + = forward), `θ̇`.

```
(M + m + Iw/r²)·ẍ + M·l·cosθ·θ̈ − M·l·sinθ·θ̇² = τ/r
 M·l·cosθ·ẍ + (Ib + M·l²)·θ̈ − M·g·l·sinθ       = −τ
τ = 2·[ kτ·(V − kb·ω_rel) − τc·tanh(ω_rel/ε) ],   ω_rel = v/r − θ̇
V = PWM/255 · (Vbat − L298N drop)
```

The simulated sensor includes:
- the MPU6050 internal filter (42 Hz);
- noise;
- the residual gyro bias;
- the linear acceleration the accelerometer sees, because it is mounted `h_imu` above the axle.

That last effect is what makes the accelerometer angle "lie" whenever the robot accelerates.

## Why the control is a cascade

`linear_analysis` shows it with numbers. With voltage-driven DC motors and **no encoders**, an **angle-only** PID leaves a positive real pole (≈ +1 1/s with the default values).

In practice the robot "balances" for a while, but it keeps drifting to one side faster and faster until the motors saturate and it falls. This is the classic problem of the typical code found online.

The firmware fixes it with an outer speed loop:

```
vEst   = low-pass(applied PWM / 255, τ = tauv)              ← at constant speed PWM ∝ speed (back-EMF)
target = trim + ks·(vRef − vEst) + kis·∫(vRef − vEst)       ← to brake it leans back
PWM    = kp·(θ − target) + ki·∫error + kd·θ̇_filtered
```

With `ks = 20` and `tauv = 0.2` s, the slowest pole moves to ≈ −3.4 1/s, which is stable. The same loop is used for driving: the joystick requests a speed `vRef`, and the robot leans only as much as needed to reach it.

## Measuring the parameters

| Parameter | How |
|---|---|
| `M`, `m` | Kitchen scale: the robot without wheels, and both wheels |
| `r` | Wheel diameter / 2 |
| `l` | Balance the robot (without wheels) lying across a pencil: the distance from that point to the axle is `l` |
| `Ib` | Approximation: `M·(height² + depth²)/12`. Or hang it from the axle as a pendulum and measure the period `T`: `Ib = M·g·l·T²/(4π²) − M·l²` |
| `T_stall`, `w_noload` | Motor datasheet. TT 1:48: ~0.8 kg·cm and ~200 rpm at 6 V |
| `tau_c` | From the minimum PWM measured with `ramp`: `tau_c ≈ k_tau·(minpwm/255)·(Vbat − Vdrop)` |
| `Vbat`, `Vdrop` | Battery; the L298N loses ~2 V |

After measuring, run `linear_analysis` and check where the star lands on the map. Ideally it sits in the blue area, far from the black line.

## Validation

The same model was tested varying each parameter (mass 0.4–0.8 kg, `l` 5–11 cm, 2S/3S battery, friction ×0.5–×1.75, motor ×0.7–×1.5, `minpwm` 15–45). With the default values the robot never falls: it recovers from a push with less than 4.5° of tilt and drives at ~0.14 m/s with the joystick at 60 %.

The simulation is a guide, not a guarantee. Final tuning happens on the robot, with the app or the Serial Monitor (see the main README).
