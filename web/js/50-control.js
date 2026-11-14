// Control page: remote control of the robot. The only page that sends commands.

const PARAM_DEFS = [
  ['kp', 'Proportional: push per degree of tilt', 0, 150, 0.5],
  ['kd', 'Derivative: damping, from the gyro', 0, 5, 0.05],
  ['ki', 'Angle integral (usually 0)', 0, 300, 1],
  ['trim', 'Fine correction of the balance point (°)', -8, 8, 0.05],
  ['ks', 'Speed loop: stops the drift', 0, 60, 0.5],
  ['kis', 'Auto-trim: removes slow drift', 0, 20, 0.1],
  ['vmax', 'Speed at full stick (fraction of full command)', 0, 0.8, 0.01],
  ['tauv', 'Speed estimator filter (s)', 0.05, 1.5, 0.01],
  ['lean', 'Most lean the speed loop may ask for (°)', 0, 15, 0.5],
  ['minpwm', 'Lowest PWM that turns the wheels', 0, 120, 1],
  ['db', 'Output dead band (PWM)', 0, 20, 0.5],
  ['turn', 'Turning strength (PWM)', 0, 150, 1],
  ['dlpf', 'Smoothing of the derivative term', 0, 0.95, 0.05],
  ['alpha', 'Complementary filter: gyro weight', 0.95, 0.999, 0.001],
];

function startControl() {
  const link = Link(true);
  const cfg = Settings.data;
  bindHeader(link);
  const twin = Twin($('#twin'), { orbit: 'full' });
  driveTwin(twin, link);

  // ---- messages and log ----
  const logEl = $('#log');
  link.on('msg', (text, history) => {
    const line = document.createElement('div');
    line.textContent = new Date().toLocaleTimeString() + '  ' + text;
    logEl.prepend(line);
    while (logEl.childElementCount > 80) logEl.lastChild.remove();
    if (!history && /error|fallen|e-stop|locked|cannot|autotune|calibrat|minpwm|saved/i.test(text)) {
      toast(text, /error|fallen|cannot|e-stop/i.test(text) ? 'bad' : '');
    }
  });

  // ---- inputs: on-screen joystick, keyboard, controller ----
  const joy = { x: 0, y: 0, active: false, keys: {} };
  const joyEl = $('#joy'), knob = $('#knob');
  const neutral = () => { joy.x = joy.y = 0; joy.active = false; joy.keys = {}; link.drive.v = link.drive.t = 0; };

  function joyMove(e) {
    const r = joyEl.getBoundingClientRect(), travel = r.width / 2 - knob.offsetWidth / 2;
    let x = (e.clientX - r.left - r.width / 2) / travel, y = -(e.clientY - r.top - r.height / 2) / travel;
    const m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    joy.x = x; joy.y = y; joy.active = true;
  }
  joyEl.addEventListener('pointerdown', e => { joyEl.setPointerCapture(e.pointerId); joyMove(e); });
  joyEl.addEventListener('pointermove', e => { if (joy.active && joyEl.hasPointerCapture(e.pointerId)) joyMove(e); });
  const release = () => { joy.x = joy.y = 0; joy.active = false; };
  joyEl.addEventListener('pointerup', release);
  joyEl.addEventListener('pointercancel', release);
  joyEl.addEventListener('lostpointercapture', release);

  const KEYS = { arrowup: [0, 1], w: [0, 1], arrowdown: [0, -1], s: [0, -1], arrowleft: [-1, 0], a: [-1, 0], arrowright: [1, 0], d: [1, 0] };
  function keyDrive() {
    let x = 0, y = 0;
    for (const k in joy.keys) { x += KEYS[k][0]; y += KEYS[k][1]; }
    joy.active = x !== 0 || y !== 0;
    joy.x = Lib.clamp(x, -1, 1) * 0.8; joy.y = Lib.clamp(y, -1, 1) * 0.8;
  }
  addEventListener('keydown', e => {
    if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'escape') { e.preventDefault(); estop(); return; }
    if (KEYS[k]) { e.preventDefault(); joy.keys[k] = 1; keyDrive(); }
  });
  addEventListener('keyup', e => {
    const k = e.key.toLowerCase();
    if (joy.keys[k]) { delete joy.keys[k]; keyDrive(); }
  });

  const pad = Pad(event => {
    if (event === 'found') toast('Controller connected. Drive stays locked until you arm it.');
    else if (event === 'lost') { toast('Controller disconnected: drive locked', 'bad'); lockDrive(); }
    else if (event === 'mapped') renderPadMap();
    else if (event === 'arm') armDrive();
    else if (event === 'disarm') lockDrive();
    else if (event === 'estop') estop();
    else if (event === 'balance') link.cmd('on');
  });

  // ---- drive lock, balance, stop ----
  async function armDrive() {
    if (link.status !== 'live') { toast('No link to the robot', 'bad'); return; }
    neutral();
    const reply = await link.cmd('arm', true);
    if (reply && !/armed/i.test(reply)) toast(reply, 'bad');
  }
  function lockDrive() {
    neutral();
    if (Store.state.arm && Store.state.own === link.id) link.cmd('disarm', true);
  }
  function estop() {
    neutral();
    link.cmd('estop', true);
  }
  $('#drive-switch').addEventListener('click', () => (link.isOwner() ? lockDrive() : armDrive()));
  $('#btn-estop').addEventListener('click', estop);
  $('#btn-balance').addEventListener('click', () => link.cmd(Store.state.e ? 'off' : 'on'));

  // Anything that takes attention or input away closes the drive lock. It is
  // never reopened automatically.
  const leave = () => {
    neutral();
    if (link.isOwner()) {
      try { fetch(`/c?q=disarm&c=${link.id}`, { keepalive: true, cache: 'no-store' }); } catch (e) { /* page is closing */ }
    }
  };
  addEventListener('blur', leave);
  addEventListener('pagehide', leave);
  document.addEventListener('visibilitychange', () => { if (document.hidden) leave(); });
  let lostWhileArmed = false;
  link.on('status', s => {
    if (s !== 'live') { if (link.isOwner()) lostWhileArmed = true; neutral(); }
    else if (lostWhileArmed) {
      lostWhileArmed = false;
      if (link.isOwner()) { lockDrive(); toast('The link was interrupted: drive locked', 'bad'); }
    }
  });

  // ---- per-frame: build the command, paint fast read-outs ----
  const el = id => $('#' + id);
  const ui = {
    mode: el('s-mode'), pitch: el('s-pitch'), target: el('s-target'), rate: el('s-rate'), pwml: el('s-pwml'), pwmr: el('s-pwmr'),
    imu: el('s-imu'), batt: el('s-batt'), loop: el('s-loop'), hudPitch: el('hud-pitch'), hudTarget: el('hud-target'),
    cmdV: el('cmd-v'), cmdT: el('cmd-t'), banner: el('banner'), lockCard: el('lock-card'), driveTitle: el('drive-title'),
    driveSub: el('drive-sub'), sw: el('drive-switch'), balance: el('btn-balance'), padChip: el('pad-chip'), padChipText: el('pad-chip-text'),
  };
  let padSvgEl = null, slow = 0;

  // Reads the inputs and sets the command for the next /j request. It runs
  // right before every poll (so it never depends on the screen being drawn)
  // and on every animation frame (so the knob follows the hand).
  const input = { x: 0, y: 0, dz: 0 };
  function updateCommand() {
    pad.poll();
    const owner = link.isOwner() && link.status === 'live' && !document.hidden;
    let x = 0, y = 0, boost = 0, precision = 0, dz = cfg.joyDz;
    if (joy.active) { x = joy.x; y = joy.y; }
    else if (pad.connected) { x = pad.x; y = pad.y; boost = pad.boost; precision = pad.precision; dz = cfg.padDz; }
    const cmd = Lib.shapeDrive(x, y, { dz, limit: cfg.limit, boost, precision });
    link.drive.v = owner ? cmd.v : 0;
    link.drive.t = owner ? cmd.t : 0;
    input.x = x; input.y = y; input.dz = dz;
    return owner;
  }
  link.beforePoll = updateCommand;

  function frame(now) {
    const owner = updateCommand();
    const { x, y, dz } = input;

    const travel = joyEl.clientWidth / 2 - knob.offsetWidth / 2;
    knob.style.transform = `translate(${(x * travel).toFixed(1)}px, ${(-y * travel).toFixed(1)}px)`;
    joyEl.dataset.live = owner ? '1' : '0';
    joyEl.classList.toggle('held', joy.active || Math.hypot(x, y) > dz);
    setText(ui.cmdV, Lib.fmt(link.drive.v, 2, true));
    setText(ui.cmdT, Lib.fmt(link.drive.t, 2, true));
    if (padSvgEl && !$('#drawer').hidden) paintPad(padSvgEl, pad);

    if (now - slow > 90) { slow = now; paintStatus(); }
    requestAnimationFrame(frame);
  }

  function paintStatus() {
    const st = Store.state, live = link.status === 'live', fresh = live && performance.now() - Store.lastSampleAt < 700;
    const F = Lib.fmt;
    setText(ui.mode, live ? (st.tune ? 'auto-tuning' : st.m || '—') : link.status === 'connecting' ? 'connecting' : 'no link');
    ui.mode.dataset.tone = !live ? 'bad' : st.m === 'balancing' ? 'ok' : st.m === 'fallen' ? 'bad' : 'warn';
    setText(ui.pitch, fresh ? F(Store.latest(1), 1, true) : '—');
    setText(ui.target, fresh ? F(Store.latest(2), 1, true) : '—');
    setText(ui.rate, fresh ? F(Store.latest(3), 0, true) : '—');
    setText(ui.pwml, fresh ? F(Store.latest(5), 0, true) : '—');
    setText(ui.pwmr, fresh ? F(Store.latest(6), 0, true) : '—');
    setText(ui.hudPitch, fresh ? F(Store.latest(1), 1, true) : '—');
    setText(ui.hudTarget, fresh ? F(Store.latest(2), 1, true) : '—');
    setText(ui.imu, !live ? '—' : st.imu ? 'OK' : 'Error');
    ui.imu.dataset.tone = live && !st.imu ? 'bad' : '';
    if (st.vb != null) { setText(ui.batt, F(st.vb, 2) + ' V'); ui.batt.classList.remove('muted'); }
    setText(ui.loop, live && st.lu != null ? String(st.lu) : '—');

    // drive lock
    const mine = link.isOwner(), other = !!st.arm && !mine;
    ui.lockCard.dataset.armed = mine ? '1' : '0';
    ui.sw.setAttribute('aria-checked', mine ? 'true' : 'false');
    setText(ui.driveTitle, mine ? 'Drive armed' : 'Balance only');
    setText(ui.driveSub, mine ? 'Joystick and controller active' : other ? 'Another device is driving' : !live ? 'No link' : !st.e ? 'Turn balancing on to drive' : 'Joystick locked');
    setText(ui.balance, st.e ? 'Balance off' : 'Balance on');
    ui.balance.classList.toggle('on', !!st.e);

    // banner over the twin
    let b = '';
    if (link.status === 'offline') b = 'No link to the robot';
    else if (link.status === 'stale') b = 'Link unstable';
    else if (live && !st.imu) b = 'IMU error: check the MPU6050 wiring';
    else if (live && st.m === 'fallen') b = 'Fallen. Stand it upright to resume';
    else if (live && st.m === 'calibrating') b = 'Calibrating: keep it still';
    else if (live && (st.m === 'motor-test' || st.m === 'ramp')) b = 'Motor test running';
    else if (live && !st.e) b = 'Balancing is off';
    else if (live && st.m === 'idle') b = 'Ready: hold it upright';
    ui.banner.hidden = !b;
    setText(ui.banner, b);
    ui.banner.dataset.tone = /error|fallen|no link/i.test(b) ? 'bad' : '';

    // controller chip
    const padState = !pad.supported ? 'off' : pad.connected ? 'on' : 'none';
    ui.padChip.dataset.state = padState;
    setText(ui.padChipText, padState === 'off' ? 'Controller unavailable here' : pad.connected ? 'Controller connected' : 'No controller');
    paintPadTab();
    const tune = $('#btn-tune');
    setText(tune, st.tune ? 'Stop auto-tune' : 'Auto-tune');
    tune.classList.toggle('on', !!st.tune);
  }

  // ---- navigation lock (press and hold to unlock) ----
  const navLock = $('#nav-lock');
  let locked = false, holdTimer = null;
  const setLocked = v => {
    locked = v;
    document.body.classList.toggle('nav-locked', v);
    navLock.setAttribute('aria-pressed', v ? 'true' : 'false');
    navLock.title = v ? 'Hold to unlock navigation' : 'Lock this page';
  };
  let justUnlocked = false;
  navLock.addEventListener('click', () => {
    if (justUnlocked) { justUnlocked = false; return; }      // the click that ends the unlocking hold
    if (!locked) { setLocked(true); toast('Page locked. Hold the padlock to unlock.'); }
    else toast('Hold the padlock to unlock');
  });
  navLock.addEventListener('pointerdown', () => {
    if (!locked) return;
    navLock.classList.add('holding');
    holdTimer = setTimeout(() => {
      navLock.classList.remove('holding');
      setLocked(false);
      justUnlocked = true;
      setTimeout(() => { justUnlocked = false; }, 600);
      toast('Page unlocked');
    }, 800);
  });
  const cancelHold = () => { navLock.classList.remove('holding'); clearTimeout(holdTimer); };
  navLock.addEventListener('pointerup', cancelHold);
  navLock.addEventListener('pointerleave', cancelHold);
  navLock.addEventListener('pointercancel', cancelHold);
  $$('[data-nav-link]').forEach(a => a.addEventListener('click', e => { if (locked) { e.preventDefault(); toast('Page locked. Hold the padlock to unlock.'); } }));
  addEventListener('beforeunload', e => { if (locked) { e.preventDefault(); e.returnValue = ''; } });

  // ---- setup drawer ----
  const drawer = $('#drawer'), scrim = $('#scrim');
  const openDrawer = tab => {
    drawer.hidden = false; scrim.hidden = false;
    if (tab) showTab(tab);
    requestAnimationFrame(() => drawer.classList.add('open'));
  };
  const closeDrawer = () => { drawer.classList.remove('open'); scrim.hidden = true; setTimeout(() => { drawer.hidden = true; }, 200); };
  function showTab(name) {
    $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
    $$('.tab', drawer).forEach(p => { p.hidden = p.dataset.pane !== name; });
  }
  $('#btn-setup').addEventListener('click', () => openDrawer());
  $('#drawer-close').addEventListener('click', closeDrawer);
  scrim.addEventListener('click', closeDrawer);
  $('#tabs').addEventListener('click', e => { if (e.target.dataset.tab) showTab(e.target.dataset.tab); });
  ui.padChip.addEventListener('click', () => openDrawer('pad'));
  $$('[data-cmd]', drawer).forEach(b => b.addEventListener('click', async () => {
    await link.cmd(b.dataset.cmd);
    if (/^(load|reset|ok|invl|invr)$/.test(b.dataset.cmd)) setTimeout(() => link.loadInfo(), 250);
  }));
  $('#btn-tune').addEventListener('click', () => link.cmd(Store.state.tune ? 'autotune stop' : 'autotune'));

  // parameters
  const inputs = {}, timers = {};
  const paramBox = $('#params');
  for (const [key, desc, lo, hi, step] of PARAM_DEFS) {
    const row = document.createElement('div');
    row.className = 'param';
    row.innerHTML = `<label for="p-${key}">${key}</label><input id="p-${key}" type="range" min="${lo}" max="${hi}" step="${step}">` +
      `<input type="number" class="num" step="${step}" aria-label="${key} value"><small>${desc}</small>`;
    const [range, number] = row.querySelectorAll('input');
    inputs[key] = [range, number];
    const send = v => { clearTimeout(timers[key]); timers[key] = setTimeout(() => link.cmd(key + ' ' + v, true), 150); };
    range.addEventListener('input', () => { number.value = range.value; send(range.value); });
    number.addEventListener('change', () => { range.value = number.value; send(number.value); });
    paramBox.appendChild(row);
  }
  link.on('info', info => {
    for (const key in inputs) {
      if (!(key in info.p) || document.activeElement === inputs[key][0] || document.activeElement === inputs[key][1]) continue;
      inputs[key][0].value = info.p[key];
      inputs[key][1].value = +info.p[key].toFixed(4);
    }
  });

  // controller tab
  $('#pad-figure').innerHTML = padSvg();
  padSvgEl = $('#pad-figure svg');
  function renderPadMap() {
    $('#pad-map').innerHTML = Object.keys(PAD_ACTIONS).map(a =>
      `<div class="map-row"><span>${PAD_ACTIONS[a]}</span><b class="num">${PAD_BUTTONS[cfg.padButtons[a]] || 'Button ' + cfg.padButtons[a]}</b>` +
      `<button class="btn small quiet" type="button" data-map="${a}">${pad.capture === a ? 'Press a button…' : 'Change'}</button></div>`).join('');
    setText($('#map-turn'), '');
    $('#map-turn').innerHTML = cfg.padLayout === 'single' ? '<b>Left stick ↔</b> turn' : '<b>Right stick ↔</b> turn';
  }
  $('#pad-map').addEventListener('click', e => {
    const a = e.target.dataset.map;
    if (!a) return;
    pad.capture = pad.capture === a ? null : a;
    renderPadMap();
  });
  let padTabKey = '';
  function paintPadTab() {
    const key = [pad.supported, pad.blocked, pad.connected, pad.id, pad.standard, isSecureContext].join('|');
    if (key === padTabKey) return;
    padTabKey = key;
    const status = $('#pad-status'), help = $('#pad-help');
    if (!pad.supported) {
      status.textContent = 'This browser does not expose controllers to this page.';
      help.innerHTML = 'Browsers may hide the Gamepad API on plain-HTTP addresses such as <b>http://192.168.4.1</b>. ' +
        'On a computer, run <b>python tools/dev_server.py --robot http://192.168.4.1</b> and open <b>http://localhost:8080/control</b>, ' +
        'or use Chrome/Edge. The on-screen joystick always works.';
    } else if (pad.connected) {
      status.textContent = pad.id + (pad.standard ? '' : '  (non-standard mapping: check the axes before driving)');
      help.textContent = 'The controller is read by this browser and sent to the robot through the same command as the joystick.';
    } else {
      status.textContent = 'No controller detected.';
      help.innerHTML = 'Connect the controller to <b>this device</b> (USB, Xbox Wireless adapter or Bluetooth), then press any button on it. ' +
        (isSecureContext ? '' : 'If nothing appears, this browser may require a secure page: see the README for the localhost bridge.');
    }
  }
  const bindRange = (id, key, scale, suffix) => {
    const input = $('#' + id), out = $('#' + id + '-out');
    input.value = Math.round(cfg[key] * scale);
    const show = () => setText(out, input.value + suffix);
    input.addEventListener('input', () => { cfg[key] = input.value / scale; Settings.save(); show(); });
    show();
  };
  bindRange('limit', 'limit', 100, '%');
  bindRange('pad-dz', 'padDz', 100, '%');
  bindRange('joy-dz', 'joyDz', 100, '%');
  const layout = $('#pad-layout'), invert = $('#pad-invert');
  layout.value = cfg.padLayout; invert.checked = cfg.padInvertY;
  layout.addEventListener('change', () => { cfg.padLayout = layout.value; Settings.save(); renderPadMap(); });
  invert.addEventListener('change', () => { cfg.padInvertY = invert.checked; Settings.save(); });
  renderPadMap();

  link.start();
  requestAnimationFrame(frame);
  return { link, twin, pad, joy };
}
