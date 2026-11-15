// Strip charts drawn straight from the telemetry rings (no data is copied).
//
// All charts on a page share one view (ChartView): the same time window, the
// same right edge, and one cursor keyed by time, so a point in time lines up
// across every signal. Conventions taken from engineering tools:
//   - stacked rows with a common time axis instead of separate cards
//   - live by default; pause to inspect, then drag to pan and wheel to zoom
//   - no line is drawn across missing data
//   - the vertical range grows at once and shrinks slowly, so it does not jitter
//
// cfg: { series: [{ field | rtt, label, color, dash }], digits, signed, minSpan,
//        zero, refs: [{ v, label }], axis: true to draw the time labels }

const ChartView = {
  window: 30,          // seconds shown
  paused: false,
  end: 0,              // robot time at the right edge while paused
  cursor: null,        // robot time under the pointer, shared by every chart
  charts: [],
  pending: false,
  now() { return this.paused ? this.end : Store.latestTime(); },
  pause() { if (!this.paused) { this.paused = true; this.end = Store.latestTime(); this.changed(); } },
  live() { this.paused = false; this.changed(); },
  setWindow(sec) { this.window = Lib.clamp(sec, 2, 120); this.changed(); },
  pan(seconds) {
    const oldest = Store.count ? Store.time(Store.first()) : 0;
    this.end = Lib.clamp(this.end + seconds, Math.min(oldest + this.window, Store.latestTime()), Store.latestTime());
    this.changed();
  },
  changed() {
    if (this.onChange) this.onChange();
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this.charts.forEach(c => c.draw(true)); });
  },
};

function seriesSource(s) {
  if (s.rtt) {
    const r = Store.rtt;
    return { count: () => r.count, first: () => Math.max(0, r.count - r.cap), time: i => r.t[i % r.cap], value: i => r.v[i % r.cap], gap: 0.6 };
  }
  return { count: () => Store.count, first: () => Store.first(), time: i => Store.time(i), value: i => Store.value(s.field, i), gap: 0.1 };
}

function StripChart(figure, cfg) {
  const canvas = $('canvas', figure), ctx = canvas.getContext('2d');
  const legend = $('.legend', figure);
  const sources = cfg.series.map(seriesSource);
  const items = cfg.series.map(s => {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const swatch = s.dash ? `background:none;height:0;border-top:2px dashed ${s.color}` : `background:${s.color}`;
    item.innerHTML = `<i style="${swatch}"></i>${s.label}<b class="num">—</b><small class="num"></small>`;
    legend.appendChild(item);
    return { value: $('b', item), range: $('small', item) };
  });
  const pad = { l: 52, r: 12, t: 6, b: cfg.axis ? 22 : 6 };
  let w = 0, h = 0, lastStamp = '', lo = NaN, hi = NaN, drag = null;
  const plotX = e => e.clientX - canvas.getBoundingClientRect().left;
  const timeAt = x => ChartView.now() - ChartView.window * (1 - (x - pad.l) / Math.max(1, w - pad.l - pad.r));

  canvas.addEventListener('pointermove', e => {
    const x = plotX(e);
    if (drag) {
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) > 4) { drag.moved = true; ChartView.pause(); drag.end = ChartView.end; }
      if (drag.moved) { ChartView.end = drag.end; ChartView.pan(-dx / Math.max(1, w - pad.l - pad.r) * ChartView.window); }
    }
    ChartView.cursor = x >= pad.l && x <= w - pad.r ? timeAt(x) : null;
    ChartView.changed();
  });
  canvas.addEventListener('pointerleave', () => { if (!drag) { ChartView.cursor = null; ChartView.changed(); } });
  canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, moved: false, end: 0 }; canvas.setPointerCapture(e.pointerId); });
  const endDrag = () => { drag = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('dblclick', () => ChartView.live());
  canvas.addEventListener('wheel', e => {
    if (!ChartView.paused && !e.ctrlKey) return;          // while live, the wheel scrolls the page
    e.preventDefault();
    ChartView.setWindow(ChartView.window * (e.deltaY > 0 ? 1.25 : 0.8));
  }, { passive: false });

  function draw(force) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const cw = Math.round(rect.width * dpr), ch = Math.round(rect.height * dpr);
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; force = true; }
    const win = ChartView.window, tNow = ChartView.now(), t0 = tNow - win;
    const stamp = [Store.count, sources[0].count(), win, tNow.toFixed(3), ChartView.cursor, ChartView.paused].join();
    if (!force && stamp === lastStamp) return;
    lastStamp = stamp;
    w = rect.width; h = rect.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;

    // visible part of each series, and its range
    let dLo = Infinity, dHi = -Infinity;
    const spans = sources.map(src => {
      const first = src.first(), n = src.count();
      let b = n - 1;
      while (b >= first && src.time(b) > tNow) b--;
      let a = b;
      while (a > first && src.time(a - 1) >= t0) a--;
      let sLo = Infinity, sHi = -Infinity;
      for (let k = a; k <= b; k++) {
        const v = src.value(k);
        if (v < sLo) sLo = v;
        if (v > sHi) sHi = v;
      }
      if (sLo < dLo) dLo = sLo;
      if (sHi > dHi) dHi = sHi;
      return { a, b, lo: sLo, hi: sHi };
    });
    if (!isFinite(dLo)) { dLo = -1; dHi = 1; }
    if (cfg.zero) { dLo = Math.min(dLo, 0); dHi = Math.max(dHi, 0); }
    const span = Math.max(dHi - dLo, cfg.minSpan || 1), mid = (dHi + dLo) / 2;
    let wantLo = mid - span * 0.58, wantHi = mid + span * 0.58;
    if (cfg.zero && dLo >= 0) { wantLo = 0; wantHi = Math.max(dHi * 1.15, span); }
    // grow at once, shrink slowly
    lo = !isFinite(lo) || wantLo < lo ? wantLo : lo + (wantLo - lo) * 0.06;
    hi = !isFinite(hi) || wantHi > hi ? wantHi : hi + (wantHi - hi) * 0.06;
    const ticks = Lib.ticks(lo, hi, Math.max(2, Math.floor(ph / 30)));
    const X = t => pad.l + (t - t0) / win * pw, Y = v => pad.t + (hi - v) / (hi - lo) * ph;

    ctx.font = '12px "Red Hat Mono", ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    const dg = ticks.step >= 1 ? 0 : ticks.step >= 0.1 ? 1 : 2;
    for (const v of ticks.values) {
      const y = Math.round(Y(v)) + 0.5;
      if (y < pad.t + 4 || y > pad.t + ph - 2) continue;
      ctx.strokeStyle = v === 0 ? 'rgba(255,255,255,.2)' : 'rgba(255,255,255,.055)';
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillStyle = '#7a7a86'; ctx.textAlign = 'right';
      ctx.fillText(v.toFixed(dg).replace('-', '−'), pad.l - 8, y);
    }
    // time grid (labels only on the row that carries the axis)
    const tstep = win <= 6 ? 1 : win <= 14 ? 2 : win <= 40 ? 5 : win <= 80 ? 10 : 20;
    const tLatest = Store.latestTime();
    ctx.textAlign = 'center';
    for (let s = Math.ceil((tLatest - tNow) / tstep) * tstep; s <= (tLatest - t0); s += tstep) {
      const x = Math.round(X(tLatest - s)) + 0.5;
      if (x < pad.l || x > w - pad.r) continue;
      ctx.strokeStyle = 'rgba(255,255,255,.045)';
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke();
      if (cfg.axis && x > pad.l + 18 && x < w - pad.r - 14) {
        ctx.fillStyle = '#6b6b76';
        ctx.fillText(s ? `−${s} s` : 'now', x, h - 9);
      }
    }
    // frame: left axis line
    ctx.strokeStyle = 'rgba(255,255,255,.14)';
    ctx.beginPath(); ctx.moveTo(pad.l + 0.5, pad.t); ctx.lineTo(pad.l + 0.5, pad.t + ph); ctx.stroke();

    ctx.save();
    ctx.beginPath(); ctx.rect(pad.l, pad.t, pw, ph); ctx.clip();
    // reference levels (for example the PWM limits)
    for (const ref of cfg.refs || []) {
      if (ref.v < lo || ref.v > hi) continue;
      const y = Math.round(Y(ref.v)) + 0.5;
      ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(255,107,107,.55)';
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,140,140,.9)'; ctx.textAlign = 'right';
      ctx.fillText(ref.label, w - pad.r - 4, y + (ref.v > 0 ? 9 : -8));
    }
    ctx.lineJoin = 'round';
    sources.forEach((src, k) => {
      const sp = spans[k], s = cfg.series[k];
      if (sp.b - sp.a < 1) return;
      const stride = Math.max(1, Math.floor((sp.b - sp.a) / (pw * 1.5)));
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.dash ? 1.2 : 1.5;
      ctx.setLineDash(s.dash ? [5, 4] : []);
      ctx.beginPath();
      let prev = -Infinity;
      for (let i = sp.a; i <= sp.b; i += stride) {
        const t = src.time(i), x = X(t), y = Y(src.value(i));
        if (t - prev > src.gap * stride) ctx.moveTo(x, y); else ctx.lineTo(x, y);   // gap in the data: lift the pen
        prev = t;
      }
      ctx.stroke();
      ctx.setLineDash([]);
    });
    ctx.restore();

    // cursor and read-outs
    const tc = ChartView.cursor;
    if (tc != null && tc >= t0 && tc <= tNow) {
      const x = Math.round(X(tc)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,.4)';
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke();
    }
    sources.forEach((src, k) => {
      const sp = spans[k];
      let i = sp.b;
      if (tc != null) while (i > sp.a && src.time(i) > tc) i--;
      const has = sp.b >= sp.a && src.count() > 0 && isFinite(sp.lo);
      setText(items[k].value, has ? Lib.fmt(src.value(i), cfg.digits, cfg.signed) : '—');
      setText(items[k].range, has ? `${Lib.fmt(sp.lo, cfg.digits, cfg.signed)} … ${Lib.fmt(sp.hi, cfg.digits, cfg.signed)}` : '');
      if (has && tc != null) {
        const x = X(src.time(i)), y = Y(src.value(i));
        if (x >= pad.l && y >= pad.t && y <= pad.t + ph) {
          ctx.fillStyle = cfg.series[k].color;
          ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill();
        }
      }
    });
  }
  const chart = { draw };
  ChartView.charts.push(chart);
  return chart;
}
