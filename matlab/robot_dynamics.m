function [ds, xdd, thdd] = robot_dynamics(s, V, p, Fpush)
%ROBOT_DYNAMICS  Nonlinear model of the two-wheeled robot (sagittal plane).
%
%   [ds, xdd, thdd] = robot_dynamics(s, V, p, Fpush)
%
%   s     = [x; v; th; thd]
%           x   wheel position (m)
%           v   speed (m/s)
%           th  body tilt (rad), positive = forward
%           thd body angular rate (rad/s)
%   V     mean voltage applied to the motors (V)
%   p     parameters (robot_params)
%   Fpush horizontal push at the centre of mass (N), optional
%
%   Lagrange equations (inverted pendulum on wheels, no slip):
%     (M + m + Iw/r^2) xdd + M l cos(th) thdd - M l sin(th) thd^2 = tau/r
%      M l cos(th) xdd + (Ib + M l^2) thdd - M g l sin(th)          = -tau
%   where tau is the total torque of both motors on the wheels
%   (the reaction -tau acts on the body):
%     tau = 2*[ k_tau*(V - k_b*w_rel) - tau_c*tanh(w_rel/eps_f) ]
%     w_rel = v/r - thd   (wheel speed relative to the body)

if nargin < 4
    Fpush = 0;
end

v   = s(2);
th  = s(3);
thd = s(4);

M = p.M;  m = p.m;  r = p.r;  l = p.l;  g = p.g;
Iw = p.Iw_total;
Ib = p.Ib;

w_rel = v/r - thd;
tau = 2*( p.k_tau*(V - p.k_b*w_rel) - p.tau_c*tanh(w_rel/p.eps_f) );

c  = cos(th);
sn = sin(th);
A = [M + m + Iw/r^2,  M*l*c;
     M*l*c,           Ib + M*l^2];
b = [tau/r + M*l*sn*thd^2 + Fpush;
     M*g*l*sn - tau + Fpush*l*c];
acc = A\b;

xdd  = acc(1);
thdd = acc(2);
ds = [v; xdd; thd; thdd];
end
