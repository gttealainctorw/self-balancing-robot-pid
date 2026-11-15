// Pure logic shared by both pages. No DOM access here: web/test/ loads this file in Node.

// One telemetry sample as sent by the firmware: scaled integers, in this order.
const FIELDS = ['t', 'pitch', 'target', 'rate', 'u', 'pwmL', 'pwmR', 'vEst', 'roll', 'yaw', 'pTerm', 'iTerm', 'dTerm'];
const SCALE = [0.001, 0.01, 0.01, 0.1, 1, 1, 1, 0.001, 0.01, 0.1, 1, 1, 1];
const UNITS = ['s', 'deg', 'deg', 'deg/s', 'PWM', 'PWM', 'PWM', 'fraction of full PWM', 'deg', 'deg/s', 'PWM', 'PWM', 'PWM'];
const SAT_PWM = 250;

const Lib = {
  FIELDS, SCALE, UNITS, SAT_PWM,

  clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; },

  // Radial dead zone: inside `dz` the output is 0; outside it is rescaled so
  // that it starts from 0 at the edge and reaches 1 at full deflection.
  deadzone(x, y, dz) {
    const m = Math.hypot(x, y);
    if (m <= dz || m === 0) return [0, 0];
    const k = Math.min(1, (m - dz) / (1 - dz)) / m;
    return [x * k, y * k];
  },

  // Stick position (x right, y forward, both -1..1) -> robot command.
  // `limit` is the speed limit (0..1). `boost` (0..1) raises it toward 1,
  // `precision` (0..1) lowers the result to as little as 35 %.
  shapeDrive(x, y, o) {
    const [dx, dy] = Lib.deadzone(x, y, o.dz);
    const limit = o.limit + (1 - o.limit) * (o.boost || 0);
    const k = limit * (1 - 0.65 * (o.precision || 0));
    return { v: Lib.clamp(dy * k, -1, 1), t: Lib.clamp(dx * k, -1, 1) };
  },

  decode(raw) { return raw.map((v, i) => v * SCALE[i]); },

  // Summary of a recording (array of raw samples). Nothing here is estimated:
  // every figure is computed from the recorded values.
  sessionStats(rows, fallAngle) {
    const n = rows.length;
    if (!n) return null;
    let sumSq = 0, maxPitch = 0, sat = 0, sumAbsU = 0, falls = 0, down = false, gaps = 0;
    for (let i = 0; i < n; i++) {
      const pitch = rows[i][1] * 0.01, err = pitch - rows[i][2] * 0.01, u = rows[i][4];
      sumSq += err * err;
      if (Math.abs(pitch) > maxPitch) maxPitch = Math.abs(pitch);
      if (Math.abs(u) >= SAT_PWM) sat++;
      sumAbsU += Math.abs(u);
      const isDown = Math.abs(pitch) > fallAngle;
      if (isDown && !down) falls++;
      down = isDown;
      if (i && rows[i][0] - rows[i - 1][0] > 50) gaps++;
    }
    return {
      samples: n,
      duration: (rows[n - 1][0] - rows[0][0]) / 1000,
      rmsError: Math.sqrt(sumSq / n),
      maxPitch,
      saturation: 100 * sat / n,
      meanAbsPwm: sumAbsU / n,
      falls,
      gaps,
    };
  },

  toCsv(rows, meta) {
    const head = ['time_s', 'pitch_deg', 'target_deg', 'pitch_rate_dps', 'controller_output_pwm',
      'left_motor_pwm', 'right_motor_pwm', 'speed_estimate', 'roll_estimate_deg', 'yaw_rate_dps',
      'p_term_pwm', 'i_term_pwm', 'd_term_pwm'];
    const digits = [3, 2, 2, 1, 0, 0, 0, 3, 2, 1, 0, 0, 0];
    const cols = rows.length ? rows[0].length : head.length;     // recordings made before the PID terms have 10 columns
    const t0 = rows.length ? rows[0][0] : 0;
    const lines = [];
    if (meta) lines.push('# ' + meta);
    lines.push(head.slice(0, cols).join(','));
    for (const r of rows) {
      lines.push(r.map((v, i) => ((i ? v : v - t0) * SCALE[i]).toFixed(digits[i])).join(','));
    }
    return lines.join('\n') + '\n';
  },

  // "Nice" axis ticks covering [lo, hi] with about `count` steps.
  ticks(lo, hi, count) {
    const span = hi - lo || 1;
    const raw = span / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(Math.abs(v) < step * 1e-6 ? 0 : v);
    return { step, values: out };
  },

  // Leader-line layout. `anchors` are points on the robot ({id, x, y}),
  // `slots` are the card positions on one side ({x, y}). Returns the order of
  // anchor ids for the slots that gives no crossing lines and the shortest
  // total length (all permutations are tried; a side holds 4 cards at most).
  assignSlots(anchors, slots) {
    const n = Math.min(anchors.length, slots.length);
    const idx = anchors.slice(0, n).map((_, i) => i);
    let best = null, bestCost = Infinity;
    const cross = (a, b, c, d) => {
      const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
      return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
    };
    const permute = (arr, k) => {
      if (k === n) {
        let crossings = 0, len = 0;
        for (let i = 0; i < n; i++) {
          len += Math.hypot(anchors[arr[i]].x - slots[i].x, anchors[arr[i]].y - slots[i].y);
          for (let j = i + 1; j < n; j++) {
            if (cross(slots[i], anchors[arr[i]], slots[j], anchors[arr[j]])) crossings++;
          }
        }
        const cost = crossings * 1e6 + len;
        if (cost < bestCost) { bestCost = cost; best = arr.slice(); }
        return;
      }
      for (let i = k; i < n; i++) {
        [arr[k], arr[i]] = [arr[i], arr[k]];
        permute(arr, k + 1);
        [arr[k], arr[i]] = [arr[i], arr[k]];
      }
    };
    permute(idx, 0);
    return { order: (best || []).map(i => anchors[i].id), crossings: Math.floor(bestCost / 1e6) };
  },

  fmt(v, digits, sign) {
    if (v == null || !isFinite(v)) return '—';
    const s = v.toFixed(digits);
    return sign && v >= 0 ? '+' + s : s;
  },

  duration(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = Lib;
