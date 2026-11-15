// Statistics page: read-only engineering view. It polls /t and never writes to the robot.

const C_VIOLET = '#9d8cff', C_BLUE = '#6aa9ff', C_SOFT = '#d4d4dc', C_AMBER = '#d9b25c';

function startStats() {
  const link = Link(false);
  const cfg = Settings.data;
  const F = Lib.fmt;
  bindHeader(link);
  const twin = Twin($('#twin2'), { orbit: 'horizontal', az: -0.55, el: 0.3, dist: 490 });
  driveTwin(twin, link);
  bindViews($('#views2'), twin);
  const fresh = () => link.status === 'live' && performance.now() - Store.lastSampleAt < 700;
  const val = (field, digits, sign) => (fresh() ? F(Store.latest(field), digits, sign) : '—');
  const P = key => (Store.info && Store.info.p[key] != null ? Store.info.p[key] : NaN);

  // ---- annotated twin ----------------------------------------------------
  // Each card is tied to a physical part by a leader line. Every value shown
  // is in the telemetry; estimates say so.
  const NOTES = [
    { id: 'imu', title: 'IMU · MPU6050', rows: [
      ['Pitch', () => val(1, 1, true) + ' °'],
      ['Roll (accel. estimate)', () => val(8, 1, true) + ' °'],
      ['Pitch rate', () => val(3, 0, true) + ' °/s'],
      ['Yaw rate', () => val(9, 0, true) + ' °/s']] },
    { id: 'mcu', title: 'Controller · Nano ESP32', rows: [
      ['Target angle', () => val(2, 1, true) + ' °'],
      ['Gains kp · kd · ks', () => (Store.info ? ['kp', 'kd', 'ks'].map(k => +P(k).toFixed(2)).join(' · ') : '—')],
      ['P · I · D', () => (fresh() ? [10, 11, 12].map(f => Lib.fmt(Store.latest(f), 0, true)).join(' · ') : '—')],
      ['Control loop', () => (Store.state.lu != null && link.status === 'live' ? Store.state.lu + ' µs' : '—')]] },
    { id: 'driver', title: 'Motor driver · L298N', rows: [
      ['Controller output', () => val(4, 0, true) + ' PWM'],
      ['Saturated', () => (fresh() ? (Math.abs(Store.latest(4)) >= Lib.SAT_PWM ? 'yes' : 'no') : '—')]] },
    { id: 'motorL', title: 'Left motor', rows: [
      ['Command', () => val(5, 0, true) + ' PWM'],
      ['Duty', () => (fresh() ? Math.round(Math.abs(Store.latest(5)) / 2.55) + ' %' : '—')]] },
    { id: 'motorR', title: 'Right motor', rows: [
      ['Command', () => val(6, 0, true) + ' PWM'],
      ['Duty', () => (fresh() ? Math.round(Math.abs(Store.latest(6)) / 2.55) + ' %' : '—')]] },
    { id: 'wheelL', title: 'Wheels', rows: [
      ['Speed est. (from command)', () => val(7, 2, true)],
      ['Encoders', () => 'none fitted']] },
  ];
  const anno = $('#anno'), leaders = $('#leaders'), markers = $('#markers');
  const cols = { left: $('#anno-left'), right: $('#anno-right') };
  NOTES.forEach((n, i) => {
    n.card = document.createElement('div');
    n.card.className = 'note glass';
    n.card.innerHTML = `<header><i class="num">${i + 1}</i><b>${n.title}</b></header>` +
      n.rows.map(r => `<div class="note-row"><span>${r[0]}</span><b class="num">—</b></div>`).join('');
    n.values = $$('.note-row b', n.card);
    n.marker = document.createElement('i');
    n.marker.className = 'marker num';
    n.marker.textContent = i + 1;
    markers.appendChild(n.marker);
    n.line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    leaders.appendChild(n.line);
    cols[i < 3 ? 'left' : 'right'].appendChild(n.card);
  });

  // Puts each card on the side its part is on, in an order that avoids crossings.
  function layoutNotes(points) {
    if (!points.imu) return;
    const byX = NOTES.slice().sort((a, b) => points[a.id].x - points[b.id].x);
    const sides = { left: byX.slice(0, 3), right: byX.slice(3) };
    for (const side in sides) {
      const col = cols[side];
      sides[side].forEach(n => { if (n.card.parentNode !== col) col.appendChild(n.card); });
      const box = anno.getBoundingClientRect();
      const slots = Array.from(col.children).sort((a, b) => a.offsetTop - b.offsetTop).map(c => {
        const r = c.getBoundingClientRect();
        return { x: (side === 'left' ? r.right : r.left) - box.left, y: r.top + r.height / 2 - box.top };
      });
      const anchors = sides[side].map(n => ({ id: n.id, x: points[n.id].x, y: points[n.id].y }));
      const order = Lib.assignSlots(anchors, slots).order;
      order.forEach((id, k) => { NOTES.find(n => n.id === id).card.style.order = k; });
    }
  }
  function drawLeaders(points) {
    const wide = getComputedStyle(leaders).display !== 'none';
    const box = anno.getBoundingClientRect(), cbox = twin.canvas.getBoundingClientRect();
    const ox = cbox.left - box.left, oy = cbox.top - box.top;
    for (const n of NOTES) {
      const p = points[n.id];
      if (!p) continue;
      const ax = p.x + ox, ay = p.y + oy;
      n.marker.style.transform = `translate(${ax.toFixed(1)}px, ${ay.toFixed(1)}px)`;
      if (!wide) continue;
      const r = n.card.getBoundingClientRect();
      const left = n.card.parentNode === cols.left;
      const sx = (left ? r.right : r.left) - box.left, sy = r.top + r.height / 2 - box.top;
      const ex = sx + (left ? 22 : -22);
      n.line.setAttribute('d', `M${sx.toFixed(1)} ${sy.toFixed(1)}H${ex.toFixed(1)}L${ax.toFixed(1)} ${ay.toFixed(1)}`);
    }
  }
  // The side and order of the cards are decided when the view settles (first
  // draw, end of an orbit, resize); the lines then follow the robot every frame.
  let laid = false;
  const relayout = () => { laid = false; twin.dirty = true; };
  twin.onOrbitEnd = relayout;
  addEventListener('resize', relayout);
  twin.onDraw = points => {
    if (!laid) { laid = true; layoutNotes(points); }
    drawLeaders(points);
  };

  // ---- charts: one stacked panel, one time axis, one cursor -------------------
  const SAT = [{ v: 255, label: 'limit +255' }, { v: -255, label: 'limit −255' }];
  StripChart($('[data-chart="pitch"]'), { digits: 2, signed: true, minSpan: 4, series: [
    { field: 1, label: 'pitch', color: C_VIOLET }, { field: 2, label: 'target', color: C_SOFT, dash: true }] });
  StripChart($('[data-chart="pid"]'), { digits: 0, signed: true, minSpan: 60, refs: SAT, series: [
    { field: 10, label: 'P', color: C_VIOLET }, { field: 11, label: 'I', color: C_AMBER }, { field: 12, label: 'D', color: C_BLUE },
    { field: 4, label: 'output', color: C_SOFT, dash: true }] });
  StripChart($('[data-chart="motor"]'), { digits: 0, signed: true, minSpan: 60, refs: SAT, series: [
    { field: 5, label: 'left', color: C_VIOLET }, { field: 6, label: 'right', color: C_BLUE }] });
  StripChart($('[data-chart="rate"]'), { digits: 1, signed: true, minSpan: 20, series: [
    { field: 3, label: 'pitch rate', color: C_BLUE }] });
  StripChart($('[data-chart="speed"]'), { digits: 3, signed: true, minSpan: 0.2, series: [
    { field: 7, label: 'speed est.', color: C_AMBER }] });
  StripChart($('[data-chart="rtt"]'), { digits: 0, zero: true, minSpan: 40, axis: true, series: [
    { rtt: true, label: 'round trip', color: C_SOFT }] });

  ChartView.window = cfg.window;
  const winSeg = $('#win-seg'), pauseBtn = $('#btn-pause'), cursorRead = $('#cursor-read');
  ChartView.onChange = () => {
    $$('button', winSeg).forEach(b => b.classList.toggle('on', +b.dataset.win === Math.round(ChartView.window)));
    setText(pauseBtn, ChartView.paused ? 'Back to live' : 'Pause');
    pauseBtn.classList.toggle('paused', ChartView.paused);
    const t = ChartView.cursor;
    setText(cursorRead, t == null ? (ChartView.paused ? 'paused' : '') : `t ${(t - Store.latestTime()).toFixed(2).replace('-', '−')} s`);
  };
  winSeg.addEventListener('click', e => {
    if (!e.target.dataset.win) return;
    cfg.window = +e.target.dataset.win; Settings.save();
    ChartView.setWindow(cfg.window);
  });
  pauseBtn.addEventListener('click', () => (ChartView.paused ? ChartView.live() : ChartView.pause()));
  ChartView.onChange();

  // ---- diagnostics ---------------------------------------------------------
  const diag = $('#diag'), diagParams = $('#diag-params'), warnings = $('#warnings');
  const diagRows = {};
  const row = (box, store, key, label) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = label; dd.className = 'num'; dd.textContent = '—';
    box.append(dt, dd);
    store[key] = dd;
  };
  [['state', 'Operating state'], ['balance', 'Balancing'], ['drive', 'Drive lock'], ['imu', 'IMU'], ['rate', 'Sample rate received'],
    ['age', 'Age of newest sample'], ['dropped', 'Samples missed by this page'], ['errors', 'Failed polls'], ['rtt', 'Round trip, avg · peak'],
    ['stations', 'Devices on the robot WiFi'], ['uptime', 'Robot uptime'], ['loop', 'Control loop time'], ['batt', 'Battery'],
    ['fw', 'Firmware']].forEach(r => row(diag, diagRows, r[0], r[1]));
  const paramRows = {};
  PARAM_DEFS.forEach(d => row(diagParams, paramRows, d[0], d[0]));
  link.on('info', info => { for (const k in paramRows) setText(paramRows[k], k in info.p ? String(+info.p[k].toFixed(4)) : '—'); });

  let rateCount = 0, rateAt = performance.now(), rateHz = 0, satAt = 0;
  link.on('samples', rows => {
    rateCount += rows.length;
    for (const r of rows) if (Math.abs(r[4]) >= Lib.SAT_PWM) satAt = performance.now();
    if (rec.on) recPush(rows);
  });

  function paintSlow() {
    const st = Store.state, live = link.status === 'live', now = performance.now(), s = link.stats;
    if (now - rateAt >= 1000) { rateHz = rateCount * 1000 / (now - rateAt); rateCount = 0; rateAt = now; }
    const age = Store.lastSampleAt ? now - Store.lastSampleAt : Infinity;
    for (const n of NOTES) n.rows.forEach((r, i) => setText(n.values[i], r[1]()));
    setText($('#st-mode'), live ? (st.tune ? 'auto-tuning' : st.m || '—') : link.status === 'connecting' ? 'connecting' : 'no link');
    $('#st-mode').dataset.tone = !live ? 'bad' : st.m === 'balancing' ? 'ok' : st.m === 'fallen' ? 'bad' : 'warn';
    setText($('#st-age'), isFinite(age) ? (age < 700 ? 'data live' : `last data ${Lib.duration(age / 1000)} ago`) : 'no data');
    $('#st-age').dataset.tone = age < 700 ? 'ok' : 'bad';

    const D = diagRows;
    setText(D.state, live ? st.m : '—');
    setText(D.balance, live ? (st.e ? 'enabled' : 'off') : '—');
    setText(D.drive, live ? (st.arm ? 'armed by a control page' : 'locked') : '—');
    setText(D.imu, live ? (st.imu ? 'ok' + (Store.info ? ' · I2C 0x' + Store.info.imuAddr.toString(16) : '') : 'ERROR') : '—');
    setText(D.rate, live ? rateHz.toFixed(0) + ' Hz' + (Store.info ? ' of ' + Store.info.sampleHz : '') : '—');
    setText(D.age, isFinite(age) ? Math.round(age) + ' ms' : '—');
    setText(D.dropped, String(s.dropped));
    setText(D.errors, `${s.errors} of ${s.polls}`);
    setText(D.rtt, s.rtt ? `${Math.round(s.rtt)} · ${Math.round(s.rttMax)} ms` : '—');
    setText(D.stations, live && st.st != null ? String(st.st) : '—');
    setText(D.uptime, live && st.up != null ? Lib.duration(st.up) : '—');
    setText(D.loop, live && st.lu != null ? `${st.lu} µs of ${Store.info ? Math.round(1e6 / Store.info.loopHz) : 5000}` : '—');
    setText(D.batt, st.vb != null ? F(st.vb, 2) + ' V' : 'not instrumented');
    setText(D.fw, Store.info ? Store.info.fw + (Store.info.sim ? ' (simulated robot)' : '') : '—');

    const w = [];
    if (link.status === 'offline') w.push(['bad', 'No link to the robot. Values on this page are not current.']);
    else if (link.status === 'stale') w.push(['warn', 'Link unstable: polls are timing out.']);
    if (live && !st.imu) w.push(['bad', 'IMU error: the MPU6050 is not responding.']);
    if (live && st.m === 'fallen') w.push(['bad', 'The robot has fallen. Motors are off until it is upright.']);
    if (live && st.imu && age > 1500 && st.m !== 'calibrating') w.push(['warn', 'No new samples although the link is up.']);
    if (now - satAt < 3000 && satAt) w.push(['warn', 'Motor command saturated in the last 3 s.']);
    if (live && st.tune) w.push(['info', 'Auto-tune is changing kp, kd and ks.']);
    if (live && st.vb == null) w.push(['info', 'Battery voltage is not instrumented (no divider wired, see config.h).']);
    if (Store.info && Store.info.sim) w.push(['info', 'Simulated robot: this data does not come from hardware.']);
    const html = w.map(x => `<li class="${x[0]}">${x[1]}</li>`).join('');
    if (warnings._h !== html) { warnings._h = html; warnings.innerHTML = html; }

    const banner = $('#banner2');
    const b = link.status === 'offline' ? 'No link to the robot' : live && !fresh() && st.m !== 'calibrating' ? 'Waiting for data' : '';
    banner.hidden = !b; setText(banner, b);

    ChartView.charts.forEach(c => c.draw());
    paintRec();
  }

  // ---- experiments -----------------------------------------------------------
  const rec = { on: false, rows: [], started: 0 };
  const MAX_ROWS = 30000;                                   // 10 minutes
  let sessions = [];
  try { sessions = JSON.parse(localStorage.getItem('bb.sessions') || '[]'); } catch (e) { sessions = []; }
  const memRows = {};                                       // rows of runs whose data did not fit in storage
  const recBtn = $('#btn-rec'), recInfo = $('#rec-info');

  function recPush(rows) {
    for (const r of rows) rec.rows.push(r);
    if (rec.rows.length >= MAX_ROWS) stopRec();
  }
  function storeRows(id, rows) {
    const text = JSON.stringify(rows);
    for (let tries = 0; tries < 20; tries++) {
      try { localStorage.setItem('bb.rows.' + id, text); return true; } catch (e) {
        const victim = sessions.find(s => s.id !== id && localStorage.getItem('bb.rows.' + s.id) != null);
        if (!victim) return false;
        localStorage.removeItem('bb.rows.' + victim.id);     // oldest data goes first; its summary stays
      }
    }
    return false;
  }
  function loadRows(id) {
    if (memRows[id]) return memRows[id];
    try { return JSON.parse(localStorage.getItem('bb.rows.' + id) || 'null'); } catch (e) { return null; }
  }
  function saveSessions() {
    try { localStorage.setItem('bb.sessions', JSON.stringify(sessions)); } catch (e) { /* storage full or disabled */ }
  }
  function stopRec() {
    rec.on = false;
    const rows = rec.rows;
    rec.rows = [];
    const stats = Lib.sessionStats(rows, Store.info ? Store.info.fallAngle : 40);
    if (!stats || stats.samples < 10) { toast('Recording too short to keep'); renderSessions(); return; }
    const id = Date.now().toString(36);
    const gains = {};
    ['kp', 'ki', 'kd', 'ks', 'kis', 'trim', 'minpwm'].forEach(k => { gains[k] = P(k); });
    sessions.push({ id, at: new Date().toISOString(), stats, gains, sim: !!(Store.info && Store.info.sim) });
    if (!storeRows(id, rows)) memRows[id] = rows;
    saveSessions();
    renderSessions();
  }
  recBtn.addEventListener('click', () => {
    if (rec.on) { stopRec(); return; }
    if (!fresh()) { toast('No live data to record', 'bad'); return; }
    rec.on = true; rec.rows = []; rec.started = performance.now();
  });
  function paintRec() {
    recBtn.classList.toggle('recording', rec.on);
    setText($('span', recBtn), rec.on ? 'Stop' : 'Record');
    setText(recInfo, rec.on ? `${Lib.duration((performance.now() - rec.started) / 1000)} · ${rec.rows.length} samples` : 'Idle');
  }
  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function renderSessions() {
    const body = $('#sessions tbody');
    $('#sessions-empty').hidden = sessions.length > 0;
    $('#sessions').hidden = !sessions.length;
    const best = sessions.reduce((m, s) => Math.min(m, s.stats.falls ? Infinity : s.stats.rmsError), Infinity);
    body.innerHTML = sessions.slice().reverse().map(s => {
      const t = new Date(s.at), st = s.stats, has = loadRows(s.id) != null;
      return `<tr class="${st.rmsError === best && sessions.length > 1 ? 'best' : ''}"><td>${t.toLocaleDateString()} ${t.toLocaleTimeString()}${s.sim ? ' <small>sim</small>' : ''}</td>` +
        `<td class="num">${Lib.duration(st.duration)}</td><td class="num">${F(st.rmsError, 2)} °</td><td class="num">${F(st.maxPitch, 1)} °</td>` +
        `<td class="num">${F(st.saturation, 1)} %</td><td class="num">${F(st.meanAbsPwm, 0)}</td><td class="num">${st.falls}</td>` +
        `<td class="num">${F(s.gains.kp, 1)} · ${F(s.gains.kd, 2)} · ${F(s.gains.ks, 1)}</td>` +
        `<td class="actions"><button class="btn small quiet" data-csv="${s.id}" ${has ? '' : 'disabled title="Data no longer stored"'}>CSV</button>` +
        `<button class="btn small quiet" data-del="${s.id}" aria-label="Delete run">✕</button></td></tr>`;
    }).join('');
  }
  $('#sessions').addEventListener('click', e => {
    const csv = e.target.dataset.csv, del = e.target.dataset.del;
    if (csv) {
      const s = sessions.find(x => x.id === csv), rows = loadRows(csv);
      if (!rows) return;
      const g = s.gains;
      const meta = `BalanceBot recording ${s.at}${s.sim ? ' (simulated robot)' : ''}; kp=${g.kp} ki=${g.ki} kd=${g.kd} ks=${g.ks} kis=${g.kis} trim=${g.trim} minpwm=${g.minpwm}`;
      download(`balancebot-${s.at.replace(/[:.]/g, '-')}.csv`, Lib.toCsv(rows, meta));
    } else if (del) {
      sessions = sessions.filter(x => x.id !== del);
      delete memRows[del];
      try { localStorage.removeItem('bb.rows.' + del); } catch (err) { /* ignore */ }
      saveSessions();
      renderSessions();
    }
  });
  renderSessions();

  link.start();
  setInterval(paintSlow, 100);
  return { link, twin, rec, view: ChartView };
}
