%% LINEAR_ANALYSIS  Stability, gain maps and comparison with LQR
%
%  1) Poles of the robot without control (one is unstable: it falls).
%  2) Why an angle-only PID is not enough with DC motors and no encoders.
%  3) kp-kd and ks-tauv stability maps with your parameters.
%  4) (Optional) LQR as a reference, if you have the Control System Toolbox.
%
%  Run:  >> linear_analysis

clear; clc;
[p, c] = robot_params();

% ---------------------------------------------------------------------
% 1) Open loop
% ---------------------------------------------------------------------
[A, B] = linear_model(p);
pa = eig(A);
fprintf('Open-loop poles: %s\n', mat2str(pa.', 3));
fprintf('  -> unstable pole at %.2f 1/s: without control it falls (time constant ~%.0f ms)\n\n', ...
        max(real(pa)), 1000/max(real(pa)));

% ---------------------------------------------------------------------
% 2) Angle-only PID vs. cascade with a speed loop
% ---------------------------------------------------------------------
c_pd = c;  c_pd.ks = 0;  c_pd.kis = 0;  c_pd.ki = 0;
[~, s_pd] = closed_loop_linear(p, c_pd);
[~, s_fw] = closed_loop_linear(p, c);
fprintf('Angle-only PD (ks = 0):          slowest pole = %+.2f 1/s  %s\n', s_pd, verdict(s_pd));
fprintf('Firmware cascade (ks = %.0f):     slowest pole = %+.2f 1/s  %s\n\n', c.ks, s_fw, verdict(s_fw));
fprintf(['With voltage-driven DC motors, an angle-only PD leaves a slow "drift"\n' ...
         'mode: the robot keeps accelerating to one side until the motors saturate.\n' ...
         'The speed loop (ks) stabilizes it by estimating speed from the PWM.\n\n']);

% ---------------------------------------------------------------------
% 3) Stability maps
% ---------------------------------------------------------------------
kps = linspace(5, 120, 70);
kds = linspace(0, 3, 60);
Z1 = zeros(numel(kds), numel(kps));
for i = 1:numel(kds)
    for j = 1:numel(kps)
        cc = c;  cc.kp = kps(j);  cc.kd = kds(i);
        [~, Z1(i,j)] = closed_loop_linear(p, cc);
    end
end

kss  = linspace(0, 60, 61);
taus = linspace(0.05, 1.5, 59);
Z2 = zeros(numel(taus), numel(kss));
for i = 1:numel(taus)
    for j = 1:numel(kss)
        cc = c;  cc.ks = kss(j);  cc.tauv = taus(i);
        [~, Z2(i,j)] = closed_loop_linear(p, cc);
    end
end

figure('Name', 'Stability maps', 'Color', 'w');
subplot(1,2,1);
imagesc(kps, kds, max(min(Z1, 2), -6)); axis xy; colorbar; hold on;
contour(kps, kds, Z1, [0 0], 'k', 'LineWidth', 2);
plot(c.kp, c.kd, 'wp', 'MarkerSize', 14, 'MarkerFaceColor', 'r');
xlabel('kp (PWM/deg)'); ylabel('kd (PWM/(deg/s))');
title(sprintf('Slowest pole (ks=%.0f, tauv=%.2f)', c.ks, c.tauv));

subplot(1,2,2);
imagesc(kss, taus, max(min(Z2, 2), -6)); axis xy; colorbar; hold on;
contour(kss, taus, Z2, [0 0], 'k', 'LineWidth', 2);
plot(c.ks, c.tauv, 'wp', 'MarkerSize', 14, 'MarkerFaceColor', 'r');
xlabel('ks (deg per unit of speed)'); ylabel('tauv (s)');
title(sprintf('Slowest pole (kp=%.0f, kd=%.2f)', c.kp, c.kd));
colormap(parula);
annotation('textbox', [0 0 1 0.05], 'String', ...
    'Blue = stable (more negative = faster recovery). Black line = stability limit. Star = current values.', ...
    'EdgeColor', 'none', 'HorizontalAlignment', 'center');

% ---------------------------------------------------------------------
% 4) Reference LQR (needs the Control System Toolbox)
% ---------------------------------------------------------------------
if exist('lqr', 'file') == 2
    Kv = (p.Vbat - p.Vdrop)/255;
    Q = diag([1, 5, 200, 2]);     % weights on x, v, th, thd
    R = 1;                        % weight on the voltage
    K = lqr(A, B, Q, R);          % u = -K*z  ->  in the firmware: u = +kp*th + ...
    fprintf('LQR (reference, assumes x and v are known):\n');
    fprintf('  PWM per degree of tilt   ~ %.1f   (compare with kp = %.1f)\n', -K(3)/Kv*pi/180, c.kp);
    fprintf('  PWM per (deg/s)          ~ %.2f  (compare with kd = %.2f)\n', -K(4)/Kv*pi/180, c.kd);
    fprintf('  PWM per (m/s) of speed   ~ %.1f\n', -K(2)/Kv);
    fprintf('  LQR poles: %s\n', mat2str(eig(A - B*K).', 3));
else
    fprintf('(No Control System Toolbox: LQR comparison skipped)\n');
end

function s = verdict(pm)
if pm < -1e-6
    s = 'STABLE';
elseif pm < 1e-6
    s = 'marginal';
else
    s = 'UNSTABLE';
end
end
