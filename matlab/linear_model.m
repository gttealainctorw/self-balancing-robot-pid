function [A, B] = linear_model(p)
%LINEAR_MODEL  Linearization of robot_dynamics around upright.
%
%   [A, B] = linear_model(p)
%   States  z = [x; v; th; thd]  (m, m/s, rad, rad/s)
%   Input   V  = mean motor voltage (V)
%   (dry friction is neglected because it is not linear)

M = p.M;  m = p.m;  r = p.r;  l = p.l;  g = p.g;
Iw = p.Iw_total;  Ib = p.Ib;
kt = 2*p.k_tau;          % two motors
kb = p.k_b;

Mm = [M + m + Iw/r^2,  M*l;
      M*l,             Ib + M*l^2];
% Right-hand side:  [tau/r ; M g l th - tau]  with
% tau = kt*(V - kb*(v/r - thd))
Rs = [0, -kt*kb/r^2, 0,     kt*kb/r;
      0,  kt*kb/r,   M*g*l, -kt*kb];
Rv = [kt/r; -kt];

acc_s = Mm\Rs;
acc_v = Mm\Rv;

A = [0 1 0 0;
     acc_s(1,:);
     0 0 0 1;
     acc_s(2,:)];
B = [0; acc_v(1); 0; acc_v(2)];
end
