function st = controller_init(armed)
%CONTROLLER_INIT  Initial controller state (as at power-up).
%   st = controller_init(armed)
%   armed = true  -> starts balancing (as if released already upright)
%   armed = false -> waits until upright within ARM_ANGLE for 0.4 s
if nargin < 1
    armed = true;
end
st.init     = false;
st.angle    = 0;
st.rateF    = 0;
st.tgt      = 0;
st.u        = 0;
st.vEst     = 0;
st.autoTrim = 0;
st.iTerm    = 0;
st.driveSm  = 0;
st.turnSm   = 0;
st.armTicks = 0;
st.runTicks = 0;
st.satTicks = 0;
st.run      = armed;
st.fallen   = false;
end
