function [pwmL, pwmR, st] = controller_step(st, a_fwd, a_up, gyro_dps, cmdV, cmdT, c)
%CONTROLLER_STEP  Exact copy of controlStep()/runStep() from the firmware.
%
%   [pwmL, pwmR, st] = controller_step(st, a_fwd, a_up, gyro_dps, cmdV, cmdT, c)
%
%   st        controller state (create it with controller_init)
%   a_fwd     accelerometer component along the calibrated "forward" direction
%   a_up      accelerometer component along the calibrated "up" direction
%   gyro_dps  measured pitch rate (deg/s)
%   cmdV      drive command from the app (-1..1)
%   cmdT      turn command from the app (-1..1)
%   c         controller parameters (robot_params)
%
%   Returns the integer PWM (-255..255) of each motor, like analogWrite.

dt = 1/c.LOOP_HZ;

% 1) Angle from the complementary filter
accAngle = atan2(a_fwd, a_up)*180/pi;
rate = gyro_dps;
if ~st.init
    st.angle = accAngle;
    st.rateF = 0;
    st.init  = true;
else
    st.angle = c.alpha*(st.angle + rate*dt) + (1 - c.alpha)*accAngle;
end
st.rateF = c.dlpf*st.rateF + (1 - c.dlpf)*rate;

% 2) Drive command with slew limit
st.driveSm = st.driveSm + sat(cmdV - st.driveSm, c.DRIVE_SLEW*dt);
st.turnSm  = st.turnSm  + sat(cmdT - st.turnSm,  c.TURN_SLEW*dt);

pwmL = 0;
pwmR = 0;

% Idle: starts on its own once the robot is almost upright
if ~st.run
    st.u = 0;
    st.tgt = c.trim;
    if abs(st.angle - c.trim) < c.ARM_ANGLE
        st.armTicks = st.armTicks + 1;
        if st.armTicks >= round(0.4*c.LOOP_HZ)
            st = start_run(st);
        end
    else
        st.armTicks = 0;
    end
    return
end

% Fall cut-off
if abs(st.angle - c.trim) > c.FALL_ANGLE
    st.run = false;
    st.fallen = true;
    st.armTicks = 0;
    st.u = 0;
    return
end

% 3) Outer loop: speed estimated from the applied PWM
st.vEst = st.vEst + (st.u/255 - st.vEst)*dt/c.tauv;
vErr = st.driveSm*c.vmax - st.vEst;
st.autoTrim = sat(st.autoTrim + c.kis*vErr*dt, c.lean);
st.tgt = c.trim + sat(st.autoTrim + c.ks*vErr, c.lean);

% 4) Inner loop: angle PID (D term uses the filtered gyro rate)
err = st.angle - st.tgt;
st.iTerm = sat(st.iTerm + c.ki*err*dt, c.I_TERM_LIMIT);
u = c.kp*err + st.iTerm + c.kd*st.rateF;
u = sat(u, 255);
st.u = u;

% 5) Differential turn + minimum-PWM compensation
tr = st.turnSm*c.turn;
pwmL = friction_comp(u + tr, c);
pwmR = friction_comp(u - tr, c);
end

% ----------------------------------------------------------------------
function st = start_run(st)
st.iTerm = 0;  st.vEst = 0;  st.autoTrim = 0;  st.u = 0;
st.rateF = 0;  st.driveSm = 0;  st.turnSm = 0;  st.armTicks = 0;
st.fallen = false;
st.run = true;
end

function y = sat(x, L)
y = min(max(x, -L), L);
end

function o = friction_comp(x, c)
% Same as frictionComp(): dead band and jump to the minimum PWM
a = abs(x);
if a < c.db
    o = 0;
    return
end
out = c.minpwm + (a - c.db)*(255 - c.minpwm)/(255 - c.db);
out = min(out, 255);
o = sign(x)*floor(out + 0.5);
end
