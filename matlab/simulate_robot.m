%% SIMULATE_ROBOT  Nonlinear simulation of the robot with the SAME control as the firmware
%
%  Plant     : robot_dynamics.m (pendulum on wheels + DC motor + friction),
%              integrated with 4th-order Runge-Kutta at 1 kHz.
%  Sensor    : MPU6050 with its internal filter, noise, gyro bias and the
%              linear acceleration that "fools" the accelerometer.
%  Controller: controller_step.m at 200 Hz, integer PWM, friction
%              compensation, exactly like balance_robot.ino.
%
%  Default scenario:
%    t = 0   released tilted 4 degrees
%    t = 5 s push of 0.6 N for 0.1 s
%    t = 8 s joystick 60 % forward for 3 s, then released
%
%  Run:      >> simulate_robot
%  Requires: base MATLAB (no toolboxes).

clear; clc;
[p, c] = robot_params();

% ------------------------- Scenario ----------------------------------
T          = 14;                          % duration (s)
angle0     = 4;                           % initial tilt (deg)
push_t     = 5.0;  push_dur = 0.1;  push_F = 0.6;   % push (s, s, N)
drive      = @(t) 0.6*(t >= 8 & t < 11);  % joystick forward (-1..1)
turn       = @(t) 0;                      % joystick turn (-1..1)
animate    = true;                        % animation at the end
rng(1);                                   % reproducible noise

% To try other gains without editing robot_params.m, e.g.:
% c.kp = 60; c.kd = 1.0; c.ks = 15;

% ------------------------- Simulation --------------------------------
dt_sim = 1e-3;
dt_c   = 1/c.LOOP_HZ;
n_sub  = round(dt_c/dt_sim);
N      = round(T/dt_c);

s   = [0; 0; angle0*pi/180; 0];           % [x; v; th; thd]
st  = controller_init(true);
k_f = 1 - exp(-2*pi*p.fc_mpu*dt_sim);     % MPU internal filter (1st order)
f_fwd_f = 0;  f_up_f = p.g;  gyr_f = 0;
V = 0;  xdd = 0;  thdd = 0;

log_t = zeros(N,1); log_th = log_t; log_est = log_t; log_tgt = log_t;
log_pwm = log_t; log_x = log_t; log_v = log_t; log_vE = log_t; log_cmd = log_t;
fell = false;

for k = 1:N
    t = (k-1)*dt_c;

    % ---- controller (200 Hz) ----
    a_fwd = -f_fwd_f + p.g*sind(p.noise_acc_deg*randn);   % calibrated "forward"
    a_up  =  f_up_f;
    gyro  = gyr_f + p.bias_gyro + p.noise_gyro*randn;
    [pwmL, pwmR, st] = controller_step(st, a_fwd, a_up, gyro, drive(t), turn(t), c);
    V = (pwmL + pwmR)/2/255*(p.Vbat - p.Vdrop);           % planar model: mean voltage

    % ---- plant (1 kHz, RK4) ----
    for j = 1:n_sub
        tt = t + (j-1)*dt_sim;
        F = push_F*(tt >= push_t && tt < push_t + push_dur);
        [k1, xdd, thdd] = robot_dynamics(s, V, p, F);
        k2 = robot_dynamics(s + 0.5*dt_sim*k1, V, p, F);
        k3 = robot_dynamics(s + 0.5*dt_sim*k2, V, p, F);
        k4 = robot_dynamics(s + dt_sim*k3, V, p, F);
        s = s + dt_sim/6*(k1 + 2*k2 + 2*k3 + k4);

        % What the MPU measures (acceleration of the point where it is mounted)
        th = s(3);  thd = s(4);  h = p.h_imu;
        pdd_x = xdd + h*cos(th)*thdd - h*sin(th)*thd^2;
        pdd_z = -h*sin(th)*thdd - h*cos(th)*thd^2;
        fx = pdd_x;  fz = pdd_z + p.g;                     % specific force
        f_fwd = fx*cos(th) - fz*sin(th);                    % body axes
        f_up  = fx*sin(th) + fz*cos(th);
        f_fwd_f = f_fwd_f + k_f*(f_fwd - f_fwd_f);
        f_up_f  = f_up_f  + k_f*(f_up  - f_up_f);
        gyr_f   = gyr_f   + k_f*(thd*180/pi - gyr_f);
    end

    log_t(k) = t;            log_th(k) = s(3)*180/pi;  log_est(k) = st.angle;
    log_tgt(k) = st.tgt;     log_pwm(k) = (pwmL + pwmR)/2;
    log_x(k) = s(1);         log_v(k) = s(2);          log_vE(k) = st.vEst;
    log_cmd(k) = drive(t);

    if abs(s(3)) > 60*pi/180
        fell = true;
        N = k;
        break
    end
end

idx = 1:N;
log_t = log_t(idx); log_th = log_th(idx); log_est = log_est(idx); log_tgt = log_tgt(idx);
log_pwm = log_pwm(idx); log_x = log_x(idx); log_v = log_v(idx); log_vE = log_vE(idx);
log_cmd = log_cmd(idx);

% ------------------------- Results -----------------------------------
fprintf('\n=== Result with kp=%.1f ki=%.1f kd=%.2f ks=%.1f kis=%.1f tauv=%.2f ===\n', ...
        c.kp, c.ki, c.kd, c.ks, c.kis, c.tauv);
if fell
    fprintf('  THE ROBOT FELL at t = %.2f s\n', log_t(end));
else
    w = log_t >= 2 & log_t < push_t;
    fprintf('  RMS tilt at rest (2-%.0f s)    : %.2f deg\n', push_t, sqrt(mean(log_th(w).^2)));
    w = log_t >= push_t & log_t < 7.9;
    fprintf('  Max tilt after the push       : %.2f deg\n', max(abs(log_th(w))));
    fprintf('  Max PWM used                  : %.0f of 255\n', max(abs(log_pwm)));
    fprintf('  Speed with joystick (t=10.5 s): %.2f m/s\n', interp1(log_t, log_v, 10.5));
    fprintf('  Total distance travelled      : %.2f m\n', log_x(end));
end

figure('Name', 'Self-balancing robot simulation', 'Color', 'w');
subplot(4,1,1);
plot(log_t, log_th, 'b'); hold on;
plot(log_t, log_est, 'c--');
plot(log_t, log_tgt, 'Color', [0.95 0.6 0.1]);
grid on; ylabel('angle (deg)');
legend('true', 'estimated (compl. filter)', 'target', 'Location', 'best');
title('Body tilt');

subplot(4,1,2);
plot(log_t, log_pwm, 'Color', [0.2 0.6 0.3]); grid on; ylabel('PWM'); hold on;
plot(log_t([1 end]), [255 255], 'k:', log_t([1 end]), [-255 -255], 'k:');
title('Motor output (saturates at \pm255)');

subplot(4,1,3);
v_scale = (p.Vbat - p.Vdrop)/p.k_b*p.r;   % PWM fraction -> no-load m/s
plot(log_t, log_v, 'b', log_t, log_vE*v_scale, 'r--', log_t, log_cmd*c.vmax*v_scale, 'k:');
grid on; ylabel('m/s');
legend('true speed', 'vEst (scaled to m/s)', 'requested by joystick', 'Location', 'best');
title('Speed loop');

subplot(4,1,4);
plot(log_t, log_x, 'k'); grid on; ylabel('x (m)'); xlabel('time (s)');
title('Position');

if animate
    animate_robot(log_t, log_x, log_th*pi/180, p, 2);
end
