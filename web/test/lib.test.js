// Run with:  node --test web/test/
const test = require('node:test');
const assert = require('node:assert/strict');
const Lib = require('../js/00-lib.js');

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('dead zone: zero inside, continuous at the edge, full at the rim', () => {
  assert.deepEqual(Lib.deadzone(0.05, 0.05, 0.1), [0, 0]);
  assert.deepEqual(Lib.deadzone(0, 0, 0.1), [0, 0]);
  const [x, y] = Lib.deadzone(0.1001, 0, 0.1);
  assert.ok(x > 0 && x < 0.001 && y === 0);
  near(Lib.deadzone(1, 0, 0.1)[0], 1);
  near(Lib.deadzone(0, -1, 0.2)[1], -1);
  const [dx, dy] = Lib.deadzone(0.6, 0.6, 0.12);                 // direction is preserved
  near(dx, dy);
});

test('drive shaping: limit, boost, precision, never above 1', () => {
  near(Lib.shapeDrive(0, 1, { dz: 0.1, limit: 0.5 }).v, 0.5);
  near(Lib.shapeDrive(0, 1, { dz: 0.1, limit: 0.5, boost: 1 }).v, 1);
  near(Lib.shapeDrive(0, 1, { dz: 0.1, limit: 0.5, precision: 1 }).v, 0.175);
  near(Lib.shapeDrive(1, 0, { dz: 0.1, limit: 0.5 }).t, 0.5);
  const c = Lib.shapeDrive(0, 0.05, { dz: 0.1, limit: 1 });
  assert.equal(c.v, 0); assert.equal(c.t, 0);
  assert.ok(Lib.shapeDrive(1, 1, { dz: 0, limit: 1, boost: 1 }).v <= 1);
});

test('sample decoding uses the firmware scales', () => {
  const d = Lib.decode([12345, 186, -1000, 55, -255, 120, -118, 350, -42, 91]);
  near(d[0], 12.345); near(d[1], 1.86); near(d[2], -10); near(d[3], 5.5);
  assert.equal(d[4], -255); assert.equal(d[5], 120); assert.equal(d[6], -118);
  near(d[7], 0.35); near(d[8], -0.42); near(d[9], 9.1);
});

test('session statistics come from the recorded rows only', () => {
  const rows = [];
  for (let i = 0; i < 100; i++) rows.push([1000 + i * 20, 200, 0, 0, i < 10 ? 255 : 100, 0, 0, 0, 0, 0]);   // pitch 2.00, target 0
  rows[50][1] = 4500;                                           // one sample past the 40 degree fall limit
  const s = Lib.sessionStats(rows, 40);
  assert.equal(s.samples, 100);
  near(s.duration, 1.98);
  assert.equal(s.falls, 1);
  near(s.maxPitch, 45);
  near(s.saturation, 10);
  near(s.meanAbsPwm, (10 * 255 + 90 * 100) / 100);
  assert.ok(s.rmsError > 2 && s.rmsError < 5);
  assert.equal(s.gaps, 0);
  assert.equal(Lib.sessionStats([], 40), null);
});

test('CSV has one line per sample, a header and time from zero', () => {
  const rows = [[5000, 186, 0, 12, -40, -38, -42, 15, 3, -7], [5020, 190, 10, 0, 0, 0, 0, 0, 0, 0]];
  const lines = Lib.toCsv(rows, 'meta').trim().split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0], '# meta');
  assert.ok(lines[1].startsWith('time_s,pitch_deg,target_deg'));
  assert.equal(lines[2], '0.000,1.86,0.00,1.2,-40,-38,-42,0.015,0.03,-0.7');
  assert.equal(lines[3].split(',')[0], '0.020');
});

test('axis ticks are round numbers inside the range', () => {
  const t = Lib.ticks(-3.2, 7.9, 5);
  assert.equal(t.step, 2);
  assert.deepEqual(t.values, [-2, 0, 2, 4, 6]);
  assert.deepEqual(Lib.ticks(0, 1, 4).values.map(v => +v.toFixed(2)), [0, 0.2, 0.4, 0.6, 0.8, 1]);
});

test('leader lines: the chosen order has no crossings', () => {
  // cards on the left edge, anchors to the right; ordering by height alone would cross
  const slots = [{ x: 0, y: 100 }, { x: 0, y: 150 }, { x: 0, y: 200 }];
  const anchors = [{ id: 'a', x: 100, y: 300 }, { id: 'b', x: 300, y: 301 }, { id: 'c', x: 200, y: 120 }];
  const r = Lib.assignSlots(anchors, slots);
  assert.equal(r.crossings, 0);
  assert.equal(new Set(r.order).size, 3);
  // random layouts with the cards left of every anchor: a crossing-free order always exists
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let k = 0; k < 200; k++) {
    const A = [0, 1, 2].map(i => ({ id: 'p' + i, x: 150 + rnd() * 300, y: rnd() * 400 }));
    const S = [60, 200, 340].map(y => ({ x: 100, y }));
    assert.equal(Lib.assignSlots(A, S).crossings, 0, 'layout ' + k);
  }
});

test('formatting helpers', () => {
  assert.equal(Lib.fmt(1.234, 1, true), '+1.2');
  assert.equal(Lib.fmt(-1.234, 1, true), '-1.2');
  assert.equal(Lib.fmt(NaN, 1), '—');
  assert.equal(Lib.duration(75), '1:15');
  assert.equal(Lib.duration(3725), '1:02:05');
});
