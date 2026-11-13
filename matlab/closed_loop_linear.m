function [Acl, slowest] = closed_loop_linear(p, c)
%CLOSED_LOOP_LINEAR  Linear robot + the firmware's cascade controller.
%
%   [Acl, slowest] = closed_loop_linear(p, c)
%
%   States: [x; v; th; thd; vE; aT; iTh]
%     vE  speed estimate (filtered PWM / 255)
%     aT  auto-trim (speed-loop integral, deg)
%     iTh integral of the angle error (deg s)
%   Continuous idealization: no sampling delay, no sensor filters, no
%   saturation or dead band (simulate_robot.m covers those).
%
%   slowest = largest real part of the relevant poles. If it is < 0 the
%   loop is stable; the more negative, the faster it recovers.

[A, B] = linear_model(p);
d  = 180/pi;                         % rad -> deg (the firmware works in degrees)
Kv = (p.Vbat - p.Vdrop)/255;         % volts per PWM unit

% u (PWM) = kp*(d*th - aT + ks*vE) + ki*iTh + kd*d*thd     (vRef = 0, trim = 0)
u = [0, 0, c.kp*d, c.kd*d, c.kp*c.ks, -c.kp, c.ki];

Acl = zeros(7);
Acl(1:4, 1:4) = A;
Acl(1:4, :)   = Acl(1:4, :) + B*Kv*u;
Acl(5, :)     = u/255/c.tauv;          % vE' = (u/255 - vE)/tauv
Acl(5, 5)     = Acl(5, 5) - 1/c.tauv;
Acl(6, 5)     = -c.kis;                % aT' = kis*(0 - vE)
Acl(7, :)     = [0, 0, d, 0, c.ks, -1, 0];   % iTh' = angle error

% Drop the modes that do not matter: position x (always a pole at 0) and
% the integrators that are switched off (kis = 0 or ki = 0).
use = [2 3 4 5];
if c.kis ~= 0, use = [use 6]; end
if c.ki  ~= 0, use = [use 7]; end
poles = eig(Acl(use, use));
slowest = max(real(poles));
end
