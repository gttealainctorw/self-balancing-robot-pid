#!/usr/bin/env python3
"""Builds web/model/robot.bin, the digital twin mesh used by the web app.

Geometry sources
  * Decks: the three STL files in web/model/cad/ (from the `models/` folder of
    github.com/adoodevv/self_balancing_robot, MIT). Their geometry is used as
    is: vertices are welded and quantized to 0.01 mm, nothing is decimated.
  * Wheels, gear motors, L298N, controller board and MPU6050: parametric
    stand-ins with catalogue dimensions, placed on the mounting features found
    in the STLs (motor slots, bracket tabs, board bosses, IMU window).

Robot frame: x forward, y left, z up, millimetres, ground at z = 0.
The STL frame maps to it as (x, y, z)_robot = (y, -x, z + lift)_stl.

File format (little endian)
  'BBT2' | u32 json length | json (padded to 4) | i16 xyz[] (padded to 4)
  | u16 triangle indices[] | u16 edge indices[]
All three arrays are delta-coded (each value minus the one `stride` places
before it, modulo 2^16; stride 3 for xyz, 1 for indices), which shrinks the
gzip size.

Usage: python tools/build_twin.py        (standard library only)
"""
import json
import math
import os
import struct

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAD = os.path.join(ROOT, 'web', 'model', 'cad')
OUT = os.path.join(ROOT, 'web', 'model', 'robot.bin')

# ---- assembly dimensions (mm) ------------------------------------------------
WHEEL_R = 32.5            # 65 mm wheel
WHEEL_W = 26.0
AXLE_Z_STL = 1.5          # axle at mid-thickness of the 3 mm base plate
LIFT = WHEEL_R - AXLE_Z_STL   # STL z -> robot z
MID_Z = 48.0              # base post shoulder: underside of the mid deck (STL z)
TOP_Z = 101.0             # mid deck top (51) + upper deck posts (50)
MOTOR_Y = 65.5            # centre of the motor slots (STL x 56..75)
TRACK_HALF = 97.0         # wheel centre plane
SCALE = 0.01              # mm per integer unit
EDGE_ANGLE = 28.0         # feature edges: dihedral angle above this (degrees)

NODE_BODY, NODE_WHEEL_L, NODE_WHEEL_R = 0, 1, 2


# ---- tiny mesh toolkit ------------------------------------------------------------
class Mesh:
    def __init__(self):
        self.v = []
        self.t = []

    def add(self, other):
        base = len(self.v)
        self.v += other.v
        self.t += [(a + base, b + base, c + base) for a, b, c in other.t]
        return self

    def map(self, fn):
        self.v = [fn(p) for p in self.v]
        return self


def box(center, size):
    cx, cy, cz = center
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    m = Mesh()
    for dz in (-hz, hz):
        for dy in (-hy, hy):
            for dx in (-hx, hx):
                m.v.append((cx + dx, cy + dy, cz + dz))
    quads = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    for a, b, c, d in quads:
        m.t += [(a, b, c), (a, c, d)]
    return m


def lathe(profile, seg, closed=True):
    """Revolves a (radius, axial) profile around the local y axis."""
    m = Mesh()
    n = len(profile)
    for i in range(seg):
        ang = 2 * math.pi * i / seg
        ca, sa = math.cos(ang), math.sin(ang)
        for r, a in profile:
            m.v.append((r * ca, a, r * sa))
    last = n if closed else n - 1
    for i in range(seg):
        j = (i + 1) % seg
        for k in range(last):
            k2 = (k + 1) % n
            a, b, c, d = i * n + k, i * n + k2, j * n + k2, j * n + k
            m.t += [(a, b, c), (a, c, d)]
    return m


def cyl_y(r, a0, a1, seg=28):
    """Solid cylinder along local y from a0 to a1."""
    return lathe([(0.0, a0), (r, a0), (r, a1), (0.0, a1)], seg, closed=False)


def rot_y(m, deg):
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return m.map(lambda p: (p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c))


def y_to_z(m):
    """Turns a part built around the local y axis so that its axis is vertical."""
    return m.map(lambda p: (p[0], -p[2], p[1]))


def move(m, d):
    return m.map(lambda p: (p[0] + d[0], p[1] + d[1], p[2] + d[2]))


def load_stl(name, z_offset):
    data = open(os.path.join(CAD, name), 'rb').read()
    n = struct.unpack_from('<I', data, 80)[0]
    if 84 + 50 * n != len(data):
        raise SystemExit('%s is not a binary STL' % name)
    m = Mesh()
    for i in range(n):
        f = struct.unpack_from('<12f', data, 84 + 50 * i)
        base = len(m.v)
        for k in (3, 6, 9):
            sx, sy, sz = f[k], f[k + 1], f[k + 2]
            m.v.append((sy, -sx, sz + z_offset + LIFT))
        m.t.append((base, base + 1, base + 2))
    return m, n


# ---- parts -----------------------------------------------------------------------
PARTS = []     # dicts: name, node, role, color, spec, mesh
STATS = {}


def part(name, mesh, color, node=NODE_BODY, role='', spec=0.25):
    PARTS.append(dict(name=name, node=node, role=role, color=color, spec=spec, mesh=mesh))


def rgb(hex_):
    return [round(int(hex_[i:i + 2], 16) / 255, 3) for i in (1, 3, 5)]


DECK = rgb('#4a4c54')
RUBBER = rgb('#16161a')
AMBER = rgb('#c79a2b')
STEEL = rgb('#a9abb3')
WHITE = rgb('#d9d9de')
PCB_RED = rgb('#8f2630')
PCB_BLUE = rgb('#24509a')
PCB_DARK = rgb('#15181d')
TERMINAL_BLUE = rgb('#2f63c4')
TERMINAL_GREEN = rgb('#3f8f5c')
BLACK = rgb('#0e0e11')


def build_decks():
    for name, z in (('base-deck.stl', 0.0), ('mid-deck.stl', MID_Z), ('upper-deck.stl', TOP_Z)):
        mesh, tris = load_stl(name, z)
        STATS[name] = tris
        part(name[:-4], mesh, DECK, spec=0.18)


def build_wheel(side):
    """side = +1 left wheel (outer face toward +y), -1 right wheel. Local frame."""
    node = NODE_WHEEL_L if side > 0 else NODE_WHEEL_R
    role = 'wheelL' if side > 0 else 'wheelR'
    h = WHEEL_W / 2
    tire = lathe([(25.5, -h), (30.5, -h), (WHEEL_R, -h + 2.5), (WHEEL_R, h - 2.5), (30.5, h), (25.5, h)], 44)
    rim = lathe([(21.0, -11.0), (25.5, -11.0), (25.5, 11.0), (21.0, 11.0)], 44)
    rim.add(cyl_y(6.5, -9.0, 11.5, 20))
    for k in range(5):                       # five spokes, as on the reference wheel
        rim.add(rot_y(box((13.5, 6.5, 0.0), (17.0, 5.0, 7.0)), 72.0 * k + 18.0))
    back = cyl_y(21.5, -7.0, -5.5, 32)
    for m in (tire, rim, back):
        if side < 0:
            m.map(lambda p: (p[0], -p[1], p[2]))
    part('tire', tire, RUBBER, node, role, spec=0.08)
    part('rim', rim, AMBER, node, role, spec=0.35)
    part('wheel-back', back, BLACK, node, role, spec=0.1)


def build_motor(side):
    role = 'motorL' if side > 0 else 'motorR'
    y = side * MOTOR_Y
    axle = WHEEL_R
    # TT gear motor standing vertically in the base-deck slot, shaft pointing outward
    gearbox = box((0.0, y, axle - 11.0 + 18.5), (22.0, 18.8, 37.0))
    part('gearbox', gearbox, AMBER, role=role, spec=0.3)
    can = move(y_to_z(cyl_y(10.0, 0.0, 23.5, 28)), (0.0, y, axle + 26.0))
    part('motor-can', can, STEEL, role=role, spec=0.7)
    cap = move(y_to_z(cyl_y(10.0, 0.0, 4.0, 28)), (0.0, y, axle + 49.5))
    part('motor-cap', cap, WHITE, role=role, spec=0.3)
    y0, y1 = sorted((side * (MOTOR_Y + 9.4), side * (TRACK_HALF - WHEEL_W / 2 + 1.0)))
    shaft = move(cyl_y(2.7, y0, y1, 14), (0.0, 0.0, axle))
    part('shaft', shaft, WHITE, role=role, spec=0.5)


def build_driver():
    z = 6.0 + LIFT                           # top of the four base-deck bosses
    part('l298n-pcb', box((0, 0, z + 0.8), (43, 43, 1.6)), PCB_RED, role='driver', spec=0.3)
    part('l298n-heatsink', box((-9.5, 0, z + 1.6 + 12.5), (15, 23, 25)), BLACK, role='driver', spec=0.45)
    blocks = Mesh()
    blocks.add(box((4.0, 17.0, z + 6.6), (10, 8, 10)))
    blocks.add(box((4.0, -17.0, z + 6.6), (10, 8, 10)))
    blocks.add(box((17.0, 0.0, z + 6.6), (8, 15, 10)))
    part('l298n-terminals', blocks, TERMINAL_BLUE, role='driver', spec=0.3)
    cap = move(y_to_z(cyl_y(4.0, 0.0, 11.0, 16)), (-9.0, 16.0, z + 1.6))
    part('l298n-cap', cap, PCB_DARK, role='driver', spec=0.5)


def build_controller():
    z = MID_Z + 6.0 + LIFT                   # top of the two mid-deck bosses
    part('shield-pcb', box((0, 0, z + 0.8), (54, 42, 1.6)), PCB_BLUE, role='mcu', spec=0.3)
    strips = Mesh()
    strips.add(box((0, 17.0, z + 6.6), (40, 7.5, 10)))
    strips.add(box((0, -17.0, z + 6.6), (40, 7.5, 10)))
    part('shield-terminals', strips, TERMINAL_GREEN, role='mcu', spec=0.3)
    headers = Mesh()
    headers.add(box((0, 7.6, z + 5.85), (38, 2.5, 8.5)))
    headers.add(box((0, -7.6, z + 5.85), (38, 2.5, 8.5)))
    part('nano-headers', headers, BLACK, role='mcu', spec=0.2)
    part('nano-pcb', box((0, 0, z + 10.9), (43.2, 18, 1.6)), PCB_DARK, role='mcu', spec=0.35)
    part('nano-module', box((-9.0, 0, z + 12.9), (14, 10, 2.4)), STEEL, role='mcu', spec=0.8)
    part('nano-usb', box((19.0, 0, z + 13.3), (7, 9, 3.2)), STEEL, role='mcu', spec=0.8)


def build_imu():
    # The top deck has a stepped pocket: a 23 x 28 mm window with a ledge at
    # z = 2 mm (STL y 4..14) carrying the two M2 bosses. The GY-521 board
    # (21 x 16 mm) rests on that ledge, visible from above.
    z = TOP_Z + 2.0 + LIFT
    part('mpu6050-pcb', box((6.0, 0.0, z + 0.8), (16, 21, 1.6)), PCB_BLUE, role='imu', spec=0.3)
    part('mpu6050-chip', box((4.5, 0.0, z + 2.1), (4, 4, 1.0)), BLACK, role='imu', spec=0.6)
    part('mpu6050-header', box((12.5, 0.0, z + 2.6), (2.5, 20, 2.0)), BLACK, role='imu', spec=0.2)


# ---- welding, edges, packing ---------------------------------------------------------
def weld(mesh):
    index = {}
    verts = []
    remap = []
    for p in mesh.v:
        q = (round(p[0] / SCALE), round(p[1] / SCALE), round(p[2] / SCALE))
        if q not in index:
            index[q] = len(verts)
            verts.append(q)
        remap.append(index[q])
    tris = []
    for a, b, c in mesh.t:
        a, b, c = remap[a], remap[b], remap[c]
        if a != b and b != c and a != c:
            tris.append((a, b, c))
    return verts, tris


def feature_edges(verts, tris):
    def normal(t):
        a, b, c = (verts[i] for i in t)
        u = [b[i] - a[i] for i in range(3)]
        v = [c[i] - a[i] for i in range(3)]
        n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
        length = math.sqrt(sum(x * x for x in n)) or 1.0
        return [x / length for x in n]

    by_edge = {}
    for t in tris:
        n = normal(t)
        for a, b in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
            by_edge.setdefault((min(a, b), max(a, b)), []).append(n)
    limit = math.cos(math.radians(EDGE_ANGLE))
    edges = []
    for e, ns in by_edge.items():
        if len(ns) != 2:
            edges.append(e)
        elif abs(sum(ns[0][i] * ns[1][i] for i in range(3))) < limit:
            edges.append(e)
    return edges


def main():
    build_decks()
    for side in (1, -1):
        build_motor(side)
        build_wheel(side)
    build_driver()
    build_controller()
    build_imu()

    pos, tri, edge, meta = [], [], [], []
    for p in PARTS:
        verts, tris = weld(p['mesh'])
        edges = feature_edges(verts, tris)
        base = len(pos) // 3
        for v in verts:
            pos += v
        meta.append(dict(n=p['name'], node=p['node'], role=p['role'], c=p['color'], k=p['spec'],
                         t=[len(tri), len(tris) * 3], e=[len(edge), len(edges) * 2]))
        for t in tris:
            tri += [base + i for i in t]
        for e in edges:
            edge += [base + i for i in e]
    nverts = len(pos) // 3
    if nverts > 65535:
        raise SystemExit('too many vertices for 16-bit indices: %d' % nverts)
    if max(abs(x) for x in pos) > 32767:
        raise SystemExit('model does not fit the int16 range at %.3f mm/unit' % SCALE)

    top = TOP_Z + 3.0 + LIFT
    header = dict(
        version=1, scale=SCALE, nv=nverts, nt=len(tri), ne=len(edge), parts=meta,
        dims=dict(wheelR=WHEEL_R, axleZ=WHEEL_R, trackHalf=TRACK_HALF, height=top, deck=[100, 150]),
        anchors=dict(
            imu=[6.0, 0.0, top + 1.0],
            motorL=[0.0, MOTOR_Y, WHEEL_R + 40.0], motorR=[0.0, -MOTOR_Y, WHEEL_R + 40.0],
            wheelL=[0.0, TRACK_HALF + 13.0, WHEEL_R], wheelR=[0.0, -TRACK_HALF - 13.0, WHEEL_R],
            driver=[-9.5, 0.0, 6.0 + LIFT + 26.0], mcu=[0.0, 0.0, MID_Z + 6.0 + LIFT + 12.0],
            axle=[0.0, 0.0, WHEEL_R], top=[0.0, 0.0, top]),
        source=dict(repo='github.com/adoodevv/self_balancing_robot', folder='models', license='MIT',
                    cad=STATS, note='decks are CAD geometry; motors, wheels and boards are parametric stand-ins'))
    js = json.dumps(header, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)

    def delta(values, stride):
        return [(values[i] - (values[i - stride] if i >= stride else 0)) & 0xFFFF for i in range(len(values))]

    body = struct.pack('<%dH' % len(pos), *delta(pos, 3))
    body += b'\0' * (-len(body) % 4)
    out = b'BBT2' + struct.pack('<I', len(js)) + js + body
    out += struct.pack('<%dH' % len(tri), *delta(tri, 1)) + struct.pack('<%dH' % len(edge), *delta(edge, 1))
    with open(OUT, 'wb') as f:
        f.write(out)
    print('robot.bin: %d bytes, %d vertices, %d triangles, %d edge segments, %d parts'
          % (len(out), nverts, len(tri) // 3, len(edge) // 2, len(meta)))
    print('CAD triangles used:', STATS)


if __name__ == '__main__':
    main()
