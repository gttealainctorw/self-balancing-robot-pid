// Shared runtime: DOM helpers, settings, the telemetry store and the link to the robot.

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

// Writes text only when it changed, so 20 Hz readouts do not thrash layout.
function setText(el, text) {
  if (el && el._t !== text) { el._t = text; el.textContent = text; }
}

function toast(text, kind) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast glass' + (kind ? ' ' + kind : '');
  el.textContent = text;
  box.appendChild(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3600);
}

const Settings = {
  data: {
    limit: 0.5, joyDz: 0.08, padDz: 0.12, padLayout: 'split', padInvertY: false,
    padButtons: { arm: 0, disarm: 2, estop: 1, balance: 9 }, window: 30,
  },
  load() {
    try { Object.assign(this.data, JSON.parse(localStorage.getItem('bb.settings') || '{}')); } catch (e) { /* private mode */ }
  },
  save() {
    try { localStorage.setItem('bb.settings', JSON.stringify(this.data)); } catch (e) { /* private mode */ }
  },
};

// ---- telemetry store ------------------------------------------------------
// Ring buffers of decoded samples, shared by the twin, the read-outs and the
// charts. Index `i` is absolute (0 = first sample since the page loaded).
const Store = {
  cap: 6000,                     // 120 s at 50 Hz
  count: 0,
  t: null, ch: null,
  rtt: { cap: 1500, count: 0, t: null, v: null },     // one entry per poll
  state: {}, info: null,
  clock: -Infinity,              // robot time minus local time (s), from the freshest arrival
  lastSampleAt: 0,               // local ms when the newest sample arrived

  init() {
    this.t = new Float64Array(this.cap);
    this.ch = Lib.FIELDS.map(() => new Float32Array(this.cap));
    this.rtt.t = new Float64Array(this.rtt.cap);
    this.rtt.v = new Float32Array(this.rtt.cap);
  },
  reset() { this.count = 0; this.rtt.count = 0; this.clock = -Infinity; },
  push(raw) {
    const k = this.count % this.cap;
    this.t[k] = raw[0] * 0.001;
    for (let i = 1; i < raw.length && i < this.ch.length; i++) this.ch[i][k] = raw[i] * Lib.SCALE[i];
    this.count++;
  },
  first() { return Math.max(0, this.count - this.cap); },
  time(i) { return this.t[i % this.cap]; },
  value(field, i) { return this.ch[field][i % this.cap]; },
  latest(field) { return this.count ? this.ch[field][(this.count - 1) % this.cap] : NaN; },
  latestTime() { return this.count ? this.t[(this.count - 1) % this.cap] : 0; },

  // Sample interpolated at robot time `ts` (seconds), written into `out` by field index.
  sampleAt(ts, out) {
    if (!this.count) return false;
    let i = this.count - 1;
    const lo = this.first();
    while (i > lo && this.time(i) > ts) i--;
    const j = Math.min(i + 1, this.count - 1);
    const t0 = this.time(i), t1 = this.time(j);
    const f = t1 > t0 ? Lib.clamp((ts - t0) / (t1 - t0), 0, 1) : 0;
    for (let c = 1; c < this.ch.length; c++) {
      const a = this.value(c, i);
      out[c] = a + (this.value(c, j) - a) * f;
    }
    out[0] = t0 + (t1 - t0) * f;
    return true;
  },
  // Robot time to display now: the newest data minus a small delay, so that
  // batches arriving every poll play back smoothly.
  displayTime(delay) {
    if (!this.count) return 0;
    return Math.min(this.latestTime(), performance.now() / 1000 + this.clock - delay);
  },
};

// ---- link to the robot ------------------------------------------------------
// control = true : polls /j (drive command + telemetry) and may send commands.
// control = false: polls /t only. It never writes anything to the robot.
function Link(control) {
  const link = {
    control,
    id: 2 + Math.floor(Math.random() * 2e9),    // new on every page load: a reload never keeps the drive lock
    period: control ? 80 : 100,
    seq: 0, msgSeq: 0, first: true,
    drive: { v: 0, t: 0 },
    status: 'connecting',
    stats: { polls: 0, errors: 0, dropped: 0, restarts: 0, rtt: 0, rttMax: 0, lastOk: 0 },
    handlers: {},
    on(name, fn) { (this.handlers[name] = this.handlers[name] || []).push(fn); return this; },
    emit(name, a, b) { (this.handlers[name] || []).forEach(fn => fn(a, b)); },

    async request(url, ms) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), ms);
      try {
        const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r;
      } finally {
        clearTimeout(timer);
      }
    },

    async poll() {
      if (this.beforePoll) this.beforePoll();   // the control page refreshes the drive command here
      const t0 = performance.now();
      const d = this.drive;
      const url = (this.control ? `/j?v=${d.v.toFixed(3)}&t=${d.t.toFixed(3)}&c=${this.id}&` : '/t?') +
        `s=${this.seq}&m=${this.msgSeq}`;
      let wait = this.period;
      try {
        const data = await (await this.request(url, 1200)).json();
        this.ingest(data, performance.now(), performance.now() - t0);
        wait = Math.max(0, this.period - (performance.now() - t0));
      } catch (e) {
        this.stats.errors++;
        wait = 300;
      }
      this.stats.polls++;
      setTimeout(() => this.poll(), wait);
    },

    ingest(d, now, rtt) {
      const st = this.stats;
      if (d.n < this.seq) {                      // the robot restarted: its counters started again
        Store.reset();
        this.seq = 0; this.msgSeq = 0; st.restarts++;
        this.emit('restart');
      }
      const rows = d.d || [];
      const firstIdx = d.n - rows.length;
      if (!this.first && firstIdx > this.seq) st.dropped += firstIdx - this.seq;
      for (const row of rows) Store.push(row);
      if (rows.length) {
        Store.lastSampleAt = now;
        const offset = rows[rows.length - 1][0] * 0.001 - now / 1000;
        Store.clock = Math.max(offset, Store.clock - 0.002);
        this.emit('samples', rows);
      }
      this.seq = d.n;
      const r = Store.rtt, k = r.count % r.cap;
      r.t[k] = Store.latestTime(); r.v[k] = rtt; r.count++;
      st.rtt = st.rtt ? st.rtt + 0.2 * (rtt - st.rtt) : rtt;
      st.rttMax = Math.max(st.rttMax * 0.995, rtt);
      st.lastOk = now;
      for (const m of d.ms || []) this.emit('msg', m, this.first);
      this.msgSeq = d.mq || 0;
      const paramsChanged = Store.state.pv !== undefined && Store.state.pv !== d.pv;
      Store.state = d;
      this.first = false;
      this.emit('state', d);
      if (paramsChanged) this.loadInfo();
    },

    async loadInfo() {
      try {
        Store.info = await (await this.request('/s', 2500)).json();
        this.emit('info', Store.info);
      } catch (e) {
        setTimeout(() => this.loadInfo(), 1500);
      }
    },

    // Text command, same set as the Serial Monitor. Control page only.
    async cmd(q, quiet) {
      if (!this.control) return null;
      try {
        const text = (await (await this.request(`/c?q=${encodeURIComponent(q)}&c=${this.id}`, 2500)).text()).trim();
        if (text && !quiet) this.emit('msg', text, false);
        return text;
      } catch (e) {
        toast('Command not delivered: ' + q, 'bad');
        return null;
      }
    },

    isOwner() { return !!Store.state.arm && Store.state.own === this.id; },

    start() {
      this.loadInfo();
      this.poll();
      setInterval(() => {
        const age = performance.now() - this.stats.lastOk;
        const s = !this.stats.lastOk ? 'connecting' : age < 700 ? 'live' : age < 3000 ? 'stale' : 'offline';
        if (s !== this.status) { this.status = s; this.emit('status', s); }
      }, 200);
    },
  };
  return link;
}

// Header pieces common to both pages: link pill, simulation badge.
function bindHeader(link) {
  const pill = $('#link-pill'), text = $('#link-text');
  const label = { connecting: 'Connecting', live: 'Live', stale: 'Unstable', offline: 'No link' };
  const paint = () => {
    pill.dataset.state = link.status;
    setText(text, label[link.status]);
    setText($('#link-ms'), link.status === 'live' ? `${Math.round(link.stats.rtt)} ms` : '');
  };
  link.on('status', paint);
  setInterval(paint, 500);
  link.on('info', info => { $('#sim-badge').hidden = !info.sim; });
  paint();
}
