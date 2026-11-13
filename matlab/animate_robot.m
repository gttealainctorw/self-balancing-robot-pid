function animate_robot(t, x, th, p, speed)
%ANIMATE_ROBOT  Simple 2D animation of the robot.
%   animate_robot(t, x, th, p, speed)
%   t, x (m), th (rad) vectors from the simulation; speed = 1 real time,
%   2 = twice as fast, etc.
if nargin < 5
    speed = 1;
end
r = p.r;
H = 2.2*p.l;                         % drawn body height
fig = figure('Name', 'Animation', 'Color', 'w');
ax = axes(fig);
axis(ax, 'equal'); hold(ax, 'on'); grid(ax, 'on');
xr = [min(x) - 0.2, max(x) + 0.2];
xlim(ax, xr); ylim(ax, [-0.02, H + 2*r + 0.05]);
plot(ax, xr, [0 0], 'k', 'LineWidth', 1.5);
ang = linspace(0, 2*pi, 40);
hw = plot(ax, x(1) + r*cos(ang), r + r*sin(ang), 'k', 'LineWidth', 2);
hr = plot(ax, [x(1) x(1)], [r r], 'k');
hb = plot(ax, [x(1), x(1) + H*sin(th(1))], [r, r + H*cos(th(1))], 'LineWidth', 6, 'Color', [0.31 0.55 1]);
ht = title(ax, '');
step = max(1, round(0.03/(t(2) - t(1))));   % ~33 frames per second
tic;
for k = 1:step:numel(t)
    if ~isvalid(fig)
        return
    end
    phi = -x(k)/r;                     % wheel rotation
    set(hw, 'XData', x(k) + r*cos(ang), 'YData', r + r*sin(ang));
    set(hr, 'XData', [x(k), x(k) + r*sin(phi)], 'YData', [r, r + r*cos(phi)]);
    set(hb, 'XData', [x(k), x(k) + H*sin(th(k))], 'YData', [r, r + H*cos(th(k))]);
    set(ht, 'String', sprintf('t = %.2f s   tilt = %+.1f deg', t(k), th(k)*180/pi));
    drawnow;
    wait = t(k)/speed - toc;
    if wait > 0
        pause(wait);
    end
end
end
