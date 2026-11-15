// Strip charts drawn straight from the telemetry rings (no data is copied).
// cfg: { series: [{ field | rtt, label, color }], unit, digits, minSpan, zero }

function seriesSource(s) {
  if (s.rtt) {
    const r = Store.rtt;
    return { count: () => r.count, first: () => Math.max(0, r.count - r.cap), time: i => r.t[i % r.cap], value: i => r.v[i % r.cap] };
  }
  return { count: () => Store.count, first: () => Store.first(), time: i => Store.time(i), value: i => Store.value(s.field, i) };
}

function StripChart(figure, cfg) {
  const canvas = $('canvas', figure), ctx = canvas.getContext('2d');
  const legend = $('.legend', figure);
  const sources = cfg.series.map(seriesSource);
  const readouts = cfg.series.map(s => {
    const item = document.createElement('span');
    item.className = 'legend-item';
    item.innerHTML = `<i style="background:${s.color}"></i>${s.label} <b class="num">—</b>`;
    legend.appendChild(item);
    return $('b', item);
  });
  let cursor = null, w = 0, h = 0, lastStamp = -1;
  const pad = { l: 46, r: 10, t: 8, b: 22 };

  canvas.addEventListener('pointermove', e => { cursor = e.clientX - canvas.getBoundingClientRect().left; lastStamp = -1; });
  canvas.addEventListener('pointerleave', () => { cursor = null; lastStamp = -1; });

  function draw() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
      canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr); lastStamp = -1;
    }
    const stamp = Store.count + sources[0].count() * 7 + Settings.data.window * 1e7;
    if (stamp === lastStamp) return;
    lastStamp = stamp;
    w = rect.width; h = rect.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const win = Settings.data.window, tNow = Store.latestTime(), t0 = tNow - win;
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;

    // visible range of each series and the value range
    let lo = Infinity, hi = -Infinity;
    const starts = sources.map(src => {
      let i = src.count() - 1;
      const first = src.first();
      while (i > first && src.time(i - 1) >= t0) i--;
      for (let k = Math.max(i, first); k < src.count(); k++) {
        const v = src.value(k);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      return Math.max(i, first);
    });
    if (!isFinite(lo)) { lo = -1; hi = 1; }
    if (cfg.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    const span = Math.max(hi - lo, cfg.minSpan || 1);
    const mid = (hi + lo) / 2;
    lo = cfg.zero && lo === 0 ? 0 : mid - span * 0.56;
    hi = cfg.zero && lo === 0 ? Math.max(hi * 1.12, span) : mid + span * 0.56;
    const ticks = Lib.ticks(lo, hi, Math.max(2, Math.floor(ph / 34)));
    const X = t => pad.l + (t - t0) / win * pw, Y = v => pad.t + (hi - v) / (hi - lo) * ph;

    ctx.font = '12px "Geist Mono", ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    const dg = ticks.step >= 1 ? 0 : ticks.step >= 0.1 ? 1 : 2;
    for (const v of ticks.values) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.strokeStyle = v === 0 ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.07)';
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillStyle = '#7d7d8a'; ctx.textAlign = 'right';
      ctx.fillText(v.toFixed(dg), pad.l - 8, y);
    }
    ctx.textAlign = 'center'; ctx.fillStyle = '#6b6b76';
    const tstep = win <= 10 ? 2 : win <= 30 ? 5 : 10;
    for (let s = 0; s <= win; s += tstep) {
      const x = Math.round(X(tNow - s)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,.05)';
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke();
      if (x > pad.l + 16) ctx.fillText(s ? `−${s} s` : 'now', Math.min(x, w - pad.r - 12), h - 9);
    }

    ctx.save();
    ctx.beginPath(); ctx.rect(pad.l, pad.t, pw, ph); ctx.clip();
    ctx.lineJoin = 'round'; ctx.lineWidth = 1.6;
    sources.forEach((src, k) => {
      const n = src.count(), start = starts[k];
      if (n - start < 2) return;
      const stride = Math.max(1, Math.floor((n - start) / (pw * 1.5)));
      ctx.strokeStyle = cfg.series[k].color;
      ctx.beginPath();
      for (let i = start; i < n; i += stride) {
        const x = X(src.time(i)), y = Y(src.value(i));
        if (i === start) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });
    ctx.restore();

    // read-out: value under the cursor, or the latest value
    let tRead = null;
    if (cursor != null && cursor >= pad.l && cursor <= w - pad.r) {
      tRead = t0 + (cursor - pad.l) / pw * win;
      ctx.strokeStyle = 'rgba(255,255,255,.35)';
      ctx.beginPath(); ctx.moveTo(Math.round(cursor) + 0.5, pad.t); ctx.lineTo(Math.round(cursor) + 0.5, pad.t + ph); ctx.stroke();
      ctx.fillStyle = '#c9c9d2'; ctx.textAlign = cursor > w / 2 ? 'right' : 'left';
      ctx.fillText(`${(tRead - tNow).toFixed(1)} s`, cursor + (cursor > w / 2 ? -6 : 6), pad.t + 8);
    }
    sources.forEach((src, k) => {
      const n = src.count();
      let i = n - 1;
      if (tRead != null) { const first = starts[k]; while (i > first && src.time(i) > tRead) i--; }
      setText(readouts[k], n ? Lib.fmt(src.value(i), cfg.digits, cfg.signed) : '—');
    });
  }
  return { draw };
}
