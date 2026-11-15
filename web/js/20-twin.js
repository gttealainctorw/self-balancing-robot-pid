// Digital twin: a small WebGL2 renderer for robot.bin (see tools/build_twin.py),
// with a Canvas 2D side view for devices without WebGL2. Both pages use it.
//
// What moves and why:
//   body pitch  <- measured pitch angle
//   body roll   <- accelerometer roll estimate
//   wheel spin, ground scroll <- integral of the COMMANDED motor PWM. The robot
//     has no encoders, so this is an indication of the command, not a speed.

const DEG = Math.PI / 180;
const WHEEL_RATE = 14;           // rad/s drawn at full command (indicative only)

// ---- mat4, column-major, written into preallocated arrays ----
const M4 = {
  mul(o, a, b) {
    for (let c = 0; c < 4; c++) {
      const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      for (let r = 0; r < 4; r++) T16[c * 4 + r] = a[r] * b0 + a[4 + r] * b1 + a[8 + r] * b2 + a[12 + r] * b3;
    }
    o.set(T16);
    return o;
  },
  ident(o) { o.fill(0); o[0] = o[5] = o[10] = o[15] = 1; return o; },
  translate(o, x, y, z) { M4.ident(o); o[12] = x; o[13] = y; o[14] = z; return o; },
  scale(o, s) { M4.ident(o); o[0] = o[5] = o[10] = s; return o; },
  rotX(o, a) { M4.ident(o); const c = Math.cos(a), s = Math.sin(a); o[5] = c; o[6] = s; o[9] = -s; o[10] = c; return o; },
  rotY(o, a) { M4.ident(o); const c = Math.cos(a), s = Math.sin(a); o[0] = c; o[2] = -s; o[8] = s; o[10] = c; return o; },
  persp(o, fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    o.fill(0);
    o[0] = f / aspect; o[5] = f; o[10] = (far + near) / (near - far); o[11] = -1; o[14] = 2 * far * near / (near - far);
    return o;
  },
  lookAt(o, e, c, up) {
    let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2];
    let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    o[0] = xx; o[1] = yx; o[2] = zx; o[3] = 0;
    o[4] = xy; o[5] = yy; o[6] = zy; o[7] = 0;
    o[8] = xz; o[9] = yz; o[10] = zz; o[11] = 0;
    o[12] = -(xx * e[0] + xy * e[1] + xz * e[2]);
    o[13] = -(yx * e[0] + yy * e[1] + yz * e[2]);
    o[14] = -(zx * e[0] + zy * e[1] + zz * e[2]);
    o[15] = 1;
    return o;
  },
};
const T16 = new Float32Array(16);

const VS = `#version 300 es
in vec3 aPos;
uniform mat4 uMVP, uMV, uM;
out vec3 vView;
out float vWorldZ;
void main() { vec4 p = vec4(aPos, 1.0); vView = (uMV * p).xyz; vWorldZ = (uM * p).z; gl_Position = uMVP * p; }`;

// Flat shading: the face normal comes from screen-space derivatives of the
// view position, so the mesh needs no normals and no duplicated vertices.
const FS = `#version 300 es
precision highp float;
in vec3 vView;
in float vWorldZ;
uniform vec3 uColor, uGlow;
uniform float uSpec, uDim, uEdge, uMirror;
out vec4 o;
void main() {
  if (uEdge > 0.5) {
    vec3 c = (mix(uColor, vec3(1.0), 0.45) * 0.8 + uGlow * 0.8) * uDim;
    o = vec4(c * 0.6, 0.6);
    return;
  }
  vec3 n = normalize(cross(dFdx(vView), dFdy(vView)));
  vec3 v = normalize(-vView);
  if (dot(n, v) < 0.0) n = -n;
  vec3 key = normalize(vec3(0.45, 0.75, 0.55));
  vec3 fill = normalize(vec3(-0.7, 0.15, 0.4));
  float hemi = 0.5 + 0.5 * n.y;
  float spec = pow(max(dot(n, normalize(key + v)), 0.0), 36.0) * uSpec;
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  vec3 c = uColor * (0.15 + 0.25 * hemi + 0.80 * max(dot(n, key), 0.0) + 0.16 * max(dot(n, fill), 0.0));
  // metals pick up a soft studio reflection: bright above, dark below
  float env = smoothstep(-0.15, 0.85, reflect(-v, n).y);
  c += vec3(0.80, 0.82, 0.95) * env * uSpec * uSpec * 0.42;
  c += vec3(spec) + vec3(0.50, 0.42, 1.0) * rim * 0.18 + uGlow * (0.30 + 0.70 * rim);
  if (uMirror > 0.5) {                       // reflection in the floor: fades with depth below it
    float f = clamp(1.0 + vWorldZ / 120.0, 0.0, 1.0);
    f *= f * 0.36;
    o = vec4(c * uDim * f, f);
    return;
  }
  o = vec4(c * uDim, 1.0);
}`;

const GROUND_VS = `#version 300 es
in vec2 aPos;
uniform mat4 uVP;
out vec2 vW;
void main() { vW = aPos; gl_Position = uVP * vec4(aPos, 0.0, 1.0); }`;

// Dotted floor (25 mm pitch) with faint 100 mm lines, a distance fade and a
// contact shadow. It scrolls with the estimated travel.
const GROUND_FS = `#version 300 es
precision highp float;
in vec2 vW;
uniform float uScroll, uDim;
out vec4 o;
void main() {
  vec2 p = vec2(vW.x + uScroll, vW.y);
  float fade = smoothstep(560.0, 90.0, length(vW));
  vec2 cell = (fract(p / 25.0 + 0.5) - 0.5) * 25.0;
  float d = length(cell);
  float dots = 1.0 - smoothstep(1.2, 1.2 + fwidth(d) * 1.5, d);
  vec2 g = abs(fract(p / 100.0 + 0.5) - 0.5) * 100.0;
  float lines = max(1.0 - smoothstep(0.0, fwidth(p.x) * 1.3, g.x), 1.0 - smoothstep(0.0, fwidth(p.y) * 1.3, g.y));
  vec2 s = vW / vec2(75.0, 125.0);
  float shadow = exp(-dot(s, s) * 1.1) * 0.6;
  float a = (dots * 0.46 + lines * 0.06) * fade * uDim;
  o = vec4(vec3(0.74, 0.70, 1.0) * a, a + shadow * (1.0 - a));
}`;

let modelPromise = null;
function loadModel() {
  if (!modelPromise) {
    modelPromise = fetch($('meta[name="bb-model"]').content)
      .then(r => { if (!r.ok) throw new Error('model HTTP ' + r.status); return r.arrayBuffer(); })
      .then(buf => {
        const dv = new DataView(buf);
        if (dv.getUint32(0, true) !== 0x32544242) throw new Error('unexpected model format');   // "BBT2"
        const jsonLen = dv.getUint32(4, true);
        const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, jsonLen)));
        const undelta = (arr, stride) => {
          for (let i = stride; i < arr.length; i++) arr[i] = (arr[i] + arr[i - stride]) & 0xffff;
          return arr;
        };
        let off = 8 + jsonLen;
        const pos = undelta(new Uint16Array(buf, off, meta.nv * 3), 3);
        off += meta.nv * 6; off += (4 - off % 4) % 4;
        const tri = undelta(new Uint16Array(buf, off, meta.nt), 1);
        off += meta.nt * 2;
        const edge = undelta(new Uint16Array(buf, off, meta.ne), 1);
        return { meta, pos: new Int16Array(pos.buffer, pos.byteOffset, pos.length), tri, edge };
      });
  }
  return modelPromise;
}

const GLOW = {
  motorL: [0.55, 0.42, 1.0], motorR: [0.55, 0.42, 1.0], wheelL: [0.45, 0.35, 0.9], wheelR: [0.45, 0.35, 0.9],
  imu: [0.30, 0.55, 1.0], mcu: [0.30, 0.55, 1.0], driver: [0.55, 0.42, 1.0],
};

// opts: { az, el, dist, orbit: 'full' | 'horizontal' }
function Twin(canvas, opts) {
  opts = opts || {};
  const twin = {
    canvas,
    pose: { pitch: 0, roll: 0, wl: 0, wr: 0, gl: 0, gr: 0, imu: true, imuGlow: 0.25, dim: 1 },
    cam: { az: opts.az != null ? opts.az : -0.62, el: opts.el != null ? opts.el : 0.36, dist: opts.dist || 510 },
    home: null,
    points: {},          // projected anchors in CSS px: name -> {x, y, front}
    ready: false, mode: 'loading', dirty: true, onDraw: null,
  };
  twin.home = Object.assign({}, twin.cam);
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: true });
  const dprCap = matchMedia('(pointer: coarse)').matches ? 1.5 : 2;
  let model = null, prog, gprog, loc = {}, gloc = {}, vaoTri, vaoEdge, vaoGround;
  let width = 0, height = 0, lastKey = '';
  const proj = new Float32Array(16), view = new Float32Array(16), vp = new Float32Array(16);
  const roll = new Float32Array(16), tmp = new Float32Array(16), tmp2 = new Float32Array(16);
  const nodeM = [new Float32Array(16), new Float32Array(16), new Float32Array(16)];
  const mv = new Float32Array(16), mvp = new Float32Array(16), mm = new Float32Array(16);
  const flip = M4.ident(new Float32Array(16)); flip[10] = -1;     // mirror about the floor
  const GLOW_ERROR = [1.0, 0.25, 0.25];
  const zero3 = [0, 0, 0], glow3 = [0, 0, 0];

  function compile(vs, fs) {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  function setupGL() {
    prog = compile(VS, FS);
    gprog = compile(GROUND_VS, GROUND_FS);
    for (const n of ['uMVP', 'uMV', 'uM', 'uColor', 'uGlow', 'uSpec', 'uDim', 'uEdge', 'uMirror']) loc[n] = gl.getUniformLocation(prog, n);
    for (const n of ['uVP', 'uScroll', 'uDim']) gloc[n] = gl.getUniformLocation(gprog, n);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, model.pos, gl.STATIC_DRAW);
    const make = indices => {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.SHORT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      return vao;
    };
    vaoTri = make(model.tri);
    vaoEdge = make(model.edge);
    vaoGround = gl.createVertexArray();
    gl.bindVertexArray(vaoGround);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-700, -700, 700, -700, -700, 700, 700, 700]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, dprCap);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (w !== canvas.width || h !== canvas.height) { canvas.width = w; canvas.height = h; twin.dirty = true; }
    width = r.width; height = r.height;
  }

  function matrices() {
    const d = model.meta.dims, c = twin.cam, p = twin.pose;
    const target = [0, 0, d.height * 0.5];
    const ce = Math.cos(c.el);
    const eye = [target[0] + c.dist * ce * Math.cos(c.az), target[1] + c.dist * ce * Math.sin(c.az), target[2] + c.dist * Math.sin(c.el)];
    // 30 degree vertical field of view; on tall, narrow stages it widens so the
    // robot keeps fitting horizontally.
    const aspect = canvas.width / canvas.height;
    const fov = aspect >= 1.35 ? 30 * DEG : 2 * Math.atan(Math.tan(15 * DEG) * 1.35 / aspect);
    M4.persp(proj, fov, aspect, 40, 4000);
    M4.lookAt(view, eye, target, [0, 0, 1]);
    M4.mul(vp, proj, view);
    M4.rotX(roll, Lib.clamp(p.roll, -25, 25) * DEG);                    // about the ground line
    // body: pitch about the axle
    M4.mul(tmp, M4.translate(tmp, 0, 0, d.axleZ), M4.rotY(tmp2, p.pitch * DEG));
    M4.mul(tmp, tmp, M4.translate(tmp2, 0, 0, -d.axleZ));
    M4.mul(nodeM[0], roll, tmp);
    // wheels: spin about their own axle (geometry is stored around the wheel centre)
    M4.mul(tmp, M4.translate(tmp, 0, d.trackHalf, d.axleZ), M4.rotY(tmp2, p.wl));
    M4.mul(nodeM[1], roll, tmp);
    M4.mul(tmp, M4.translate(tmp, 0, -d.trackHalf, d.axleZ), M4.rotY(tmp2, p.wr));
    M4.mul(nodeM[2], roll, tmp);
  }

  function project() {
    const a = model.meta.anchors;
    for (const name in a) {
      const m = name.startsWith('wheel') || name === 'axle' ? roll : nodeM[0];
      const [x, y, z] = a[name];
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12], wy = m[1] * x + m[5] * y + m[9] * z + m[13], wz = m[2] * x + m[6] * y + m[10] * z + m[14];
      const cx = vp[0] * wx + vp[4] * wy + vp[8] * wz + vp[12], cy = vp[1] * wx + vp[5] * wy + vp[9] * wz + vp[13], cw = vp[3] * wx + vp[7] * wy + vp[11] * wz + vp[15];
      const pt = twin.points[name] || (twin.points[name] = {});
      pt.x = (cx / cw * 0.5 + 0.5) * width;
      pt.y = (0.5 - cy / cw * 0.5) * height;
    }
  }

  function drawParts(pass, mirror) {
    // pass 0: faces, pass 1: feature edges. mirror: the reflection under the floor.
    const p = twin.pose, s = model.meta.scale;
    gl.bindVertexArray(pass ? vaoEdge : vaoTri);
    gl.uniform1f(loc.uEdge, pass);
    gl.uniform1f(loc.uMirror, mirror ? 1 : 0);
    let node = -1;
    for (const part of model.meta.parts) {
      const range = pass ? part.e : part.t;
      if (!range[1]) continue;
      if (part.node !== node) {
        node = part.node;
        M4.mul(mm, mirror ? M4.mul(tmp2, flip, nodeM[node]) : nodeM[node], M4.scale(tmp, s));
        M4.mul(mvp, vp, mm);
        gl.uniformMatrix4fv(loc.uMVP, false, mvp);
        gl.uniformMatrix4fv(loc.uM, false, mm);
        gl.uniformMatrix4fv(loc.uMV, false, M4.mul(mv, view, mm));
      }
      let g = 0;
      if (part.role === 'motorL' || part.role === 'wheelL') g = p.gl;
      else if (part.role === 'motorR' || part.role === 'wheelR') g = p.gr;
      else if (part.role === 'imu') g = p.imuGlow;
      let glow = zero3;
      if (g > 0.004) {
        const base = part.role === 'imu' && !p.imu ? GLOW_ERROR : GLOW[part.role];
        glow3[0] = base[0] * g; glow3[1] = base[1] * g; glow3[2] = base[2] * g;
        glow = glow3;
      }
      gl.uniform3fv(loc.uColor, part.c);
      gl.uniform3fv(loc.uGlow, glow);
      gl.uniform1f(loc.uSpec, part.k);
      gl.drawElements(pass ? gl.LINES : gl.TRIANGLES, range[1], gl.UNSIGNED_SHORT, range[0] * 2);
    }
  }

  function draw() {
    const p = twin.pose;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    matrices();

    // 1) reflection of the robot in the floor (mirrored about z = 0, fading with depth)
    gl.useProgram(prog);
    gl.uniform1f(loc.uDim, 0.35 + 0.65 * p.dim);
    gl.disable(gl.BLEND);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    drawParts(0, true);

    // 2) floor: dots, faint lines, contact shadow
    gl.useProgram(gprog);
    gl.enable(gl.BLEND);
    gl.depthMask(false);
    gl.disable(gl.DEPTH_TEST);
    gl.uniformMatrix4fv(gloc.uVP, false, vp);
    gl.uniform1f(gloc.uScroll, -((p.wl + p.wr) / 2) * model.meta.dims.wheelR);
    gl.uniform1f(gloc.uDim, p.dim);
    gl.bindVertexArray(vaoGround);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);

    // 3) the robot: faces, then feature edges
    gl.useProgram(prog);
    gl.disable(gl.BLEND);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 1);
    drawParts(0, false);
    gl.enable(gl.BLEND);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    drawParts(1, false);
    gl.bindVertexArray(null);
    project();
  }

  // ---- Canvas 2D side view: same pose, for browsers without WebGL2 ----
  function draw2d() {
    const ctx = canvas.getContext('2d'), p = twin.pose, dpr = canvas.width / width;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const k = Math.min(width / 260, height / 190), ox = width / 2, oy = height * 0.86;
    const X = (x, z) => ox + x * k, Y = (x, z) => oy - z * k;
    ctx.globalAlpha = 0.4 + 0.6 * p.dim;
    ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, oy); ctx.lineTo(width, oy); ctx.stroke();
    const th = p.pitch * DEG, az = 32.5;
    const R = (x, z) => [x * Math.cos(th) + (z - az) * Math.sin(th), az - x * Math.sin(th) + (z - az) * Math.cos(th)];
    ctx.strokeStyle = '#9a9aa6'; ctx.lineWidth = 3;
    for (const z of [31, 79, 132]) {
      const a = R(-50, z), b = R(50, z);
      ctx.beginPath(); ctx.moveTo(X(a[0]), Y(0, a[1])); ctx.lineTo(X(b[0]), Y(0, b[1])); ctx.stroke();
    }
    ctx.lineWidth = 2;
    for (const x of [-38, 38]) {
      const a = R(x, 31), b = R(x, 132);
      ctx.beginPath(); ctx.moveTo(X(a[0]), Y(0, a[1])); ctx.lineTo(X(b[0]), Y(0, b[1])); ctx.stroke();
    }
    ctx.strokeStyle = '#c79a2b'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(X(0), Y(0, az), 32.5 * k, 0, 7); ctx.stroke();
    for (let i = 0; i < 5; i++) {
      const a = p.wl + i * 72 * DEG;
      ctx.beginPath(); ctx.moveTo(X(0), Y(0, az)); ctx.lineTo(X(Math.sin(a) * 26), Y(0, az + Math.cos(a) * 26)); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const anchors = { imu: [1, 135], mcu: [0, 97], driver: [-9, 63], motorL: [0, 72], motorR: [0, 72], wheelL: [0, az], wheelR: [0, az], axle: [0, az], top: [0, 135] };
    for (const n in anchors) {
      const q = n.startsWith('wheel') || n === 'axle' ? anchors[n] : R(anchors[n][0], anchors[n][1]);
      twin.points[n] = { x: X(q[0]), y: Y(0, q[1]) };
    }
  }

  const VIEWS = { iso: twin.home, side: { az: -Math.PI / 2, el: 0.05 }, front: { az: 0, el: 0.1 }, top: { az: -Math.PI / 2, el: 1.35 } };
  let goal = null;
  twin.view = function (name) {
    const v = VIEWS[name] || twin.home;
    goal = { az: v.az, el: v.el, dist: twin.home.dist };
    twin.viewName = name;
  };

  twin.frame = function () {
    if (!twin.ready) return;
    resize();
    if (goal) {
      const c = twin.cam;
      let d = goal.az - c.az;
      d = Math.atan2(Math.sin(d), Math.cos(d));                    // shortest way round
      c.az += d * 0.18; c.el += (goal.el - c.el) * 0.18; c.dist += (goal.dist - c.dist) * 0.18;
      if (Math.abs(d) < 0.002 && Math.abs(goal.el - c.el) < 0.002) { c.az += d; c.el = goal.el; c.dist = goal.dist; goal = null; if (twin.onOrbitEnd) twin.onOrbitEnd(); }
    }
    const p = twin.pose, c = twin.cam;
    const key = [p.pitch.toFixed(2), p.roll.toFixed(1), p.wl.toFixed(3), p.wr.toFixed(3), p.gl.toFixed(2), p.gr.toFixed(2),
      p.imu, p.dim.toFixed(2), c.az.toFixed(4), c.el.toFixed(4), c.dist.toFixed(1), canvas.width, canvas.height].join();
    if (key === lastKey && !twin.dirty) return;
    lastKey = key; twin.dirty = false;
    if (twin.mode === 'webgl') draw(); else draw2d();
    if (twin.onDraw) twin.onDraw(twin.points);
  };

  // ---- orbit ----
  let drag = null;
  canvas.addEventListener('pointerdown', e => {
    if (twin.mode !== 'webgl') return;
    goal = null;
    drag = { x: e.clientX, y: e.clientY, az: twin.cam.az, el: twin.cam.el };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return;
    twin.cam.az = drag.az - (e.clientX - drag.x) * 0.008;
    if (opts.orbit !== 'horizontal') twin.cam.el = Lib.clamp(drag.el + (e.clientY - drag.y) * 0.006, 0.06, 1.35);
  });
  const end = () => { if (drag) { drag = null; if (twin.onOrbitEnd) twin.onOrbitEnd(); } };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('dblclick', () => twin.view('iso'));
  canvas.addEventListener('wheel', e => {
    if (twin.mode !== 'webgl' || !e.ctrlKey && opts.orbit === 'horizontal') return;
    e.preventDefault();
    twin.cam.dist = Lib.clamp(twin.cam.dist * (1 + e.deltaY * 0.001), 380, 1100);
  }, { passive: false });

  if (gl) {
    loadModel().then(m => {
      model = m;
      setupGL();
      twin.mode = 'webgl';
      twin.meta = m.meta;
      twin.ready = true;
      canvas.dataset.mode = 'webgl';
    }).catch(err => {
      console.error(err);
      twin.mode = '2d-error'; twin.ready = false;
      canvas.dataset.mode = 'error';
      toast('3D model could not be loaded', 'bad');
    });
  } else {
    twin.mode = '2d';
    twin.ready = true;
    canvas.dataset.mode = '2d';
  }
  return twin;
}

// Camera preset buttons (Iso / Side / Front / Top) for a twin.
function bindViews(box, twin) {
  const mark = name => $$('button', box).forEach(b => b.classList.toggle('on', b.dataset.view === name));
  box.addEventListener('click', e => {
    const name = e.target.dataset.view;
    if (!name) return;
    twin.view(name);
    mark(name);
  });
  twin.canvas.addEventListener('pointerdown', () => mark(''));       // a manual orbit is no preset
  twin.canvas.addEventListener('dblclick', () => mark('iso'));
}

// Feeds a twin from the telemetry store. Shared by both pages so that the
// two views can never disagree about how telemetry maps to motion.
function driveTwin(twin, link) {
  const s = new Float32Array(Lib.FIELDS.length);
  const pose = twin.pose;
  let last = performance.now();
  const delay = link.period / 1000 + 0.06;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const fresh = link.status === 'live' && now - Store.lastSampleAt < 700;
    if (fresh && Store.sampleAt(Store.displayTime(delay), s)) {
      pose.pitch = s[1];
      pose.roll = s[8];
      pose.wl += s[5] / 255 * WHEEL_RATE * dt;
      pose.wr += s[6] / 255 * WHEEL_RATE * dt;
      pose.gl = Math.min(1, Math.abs(s[5]) / 255);
      pose.gr = Math.min(1, Math.abs(s[6]) / 255);
    } else {
      pose.gl = pose.gr = 0;
    }
    pose.imu = Store.state.imu !== 0;
    pose.imuGlow = pose.imu ? 0.22 : 0.9;
    pose.dim += ((fresh ? 1 : 0.3) - pose.dim) * Math.min(1, dt * 8);
    twin.frame();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
