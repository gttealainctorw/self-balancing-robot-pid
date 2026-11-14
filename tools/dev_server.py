#!/usr/bin/env python3
"""Development server for the BalanceBot web app.

Two modes:

  python tools/dev_server.py
      Serves web/ with a SIMULATED robot that speaks the firmware's HTTP API
      (same endpoints, same JSON). The app shows a "Simulation" badge.

  python tools/dev_server.py --robot http://192.168.4.1
      Localhost bridge to the REAL robot: the page comes from this computer
      and /t, /j, /c, /s are forwarded to the robot. http://localhost is a
      secure context, which browsers that hide the Gamepad API on plain-HTTP
      origins require. The computer must be joined to the robot's WiFi.

Options: --port 8080, --host 127.0.0.1 (use 0.0.0.0 to open it from a phone).
Standard library only.
"""
import argparse
import json
import math
import random
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import build_web

DT = 0.005
SAMPLE_DIV = 4
PARAMS = dict(kp=45.0, ki=0.0, kd=0.6, dlpf=0.5, trim=0.0, ks=20.0, kis=0.0, vmax=0.35, tauv=0.2,
              lean=10.0, minpwm=28.0, db=2.0, turn=60.0, alpha=0.99)
LIMITS = dict(kp=(0, 500), ki=(0, 2000), kd=(0, 50), dlpf=(0, 0.98), trim=(-15, 15), ks=(0, 300),
              kis=(0, 200), vmax=(0, 1), tauv=(0.02, 5), lean=(0, 25), minpwm=(0, 200), db=(0, 60),
              turn=(0, 255), alpha=(0.9, 0.9995))
PLANT = dict(M=0.55, m=0.06, r=0.0325, l=0.07, Ib=0.0015, Jrot=2.8e-4, g=9.81, k_tau=0.013, k_b=0.287,
             tau_c=0.008, Vbat=7.4, Vdrop=2.0)


def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


class SimRobot:
    """A small pendulum-on-wheels model driven by a copy of the firmware controller."""

    def __init__(self):
        self.lock = threading.Lock()
        self.p = dict(PARAMS)
        self.saved = dict(PARAMS)
        self.invl = self.invr = 0
        self.t0 = time.perf_counter()
        self.s = [0.0, 0.0, math.radians(1.0), 0.0]      # x, v, pitch, pitch rate
        self.yaw_rate = 0.0
        self.mode = 'idle'
        self.enabled = True
        self.fallen = False
        self.imu = True
        self.tune = False
        self.armed = False
        self.owner = 0
        self.drive = self.turn = 0.0
        self.last_cmd = 0.0
        self.drive_sm = self.turn_sm = 0.0
        self.angle = 1.0
        self.rate = self.rate_f = 0.0
        self.tgt = self.u = self.v_est = self.auto_trim = self.i_term = 0.0
        self.pwm_l = self.pwm_r = 0
        self.arm_ticks = self.run_ticks = self.sat_ticks = self.down_ticks = 0
        self.mode_ticks = 0
        self.ramp_pwm = 0
        self.samples = []
        self.head = 0
        self.tick_n = 0
        self.msgs = []
        self.kick = 0.0
        self.report('Simulated robot ready')

    # -- helpers ------------------------------------------------------------
    def millis(self):
        return int((time.perf_counter() - self.t0) * 1000)

    def report(self, text):
        self.msgs.append(text)

    def disarm(self):
        self.armed = False
        self.drive = self.turn = 0.0

    def friction_comp(self, x):
        a = abs(x)
        if a < self.p['db']:
            return 0
        out = self.p['minpwm'] + (a - self.p['db']) * (255 - self.p['minpwm']) / (255 - self.p['db'])
        return int(math.copysign(min(255.0, out) + 0.5, x))

    def plant(self, volts, dt):
        P = PLANT
        x, v, th, thd = self.s
        Iw = 2 * 0.5 * (P['m'] / 2) * P['r'] ** 2 + P['Jrot']
        w = v / P['r'] - thd
        tau = 2 * (P['k_tau'] * (volts - P['k_b'] * w) - P['tau_c'] * math.tanh(w / 0.1))
        c, s = math.cos(th), math.sin(th)
        a11 = P['M'] + P['m'] + Iw / P['r'] ** 2
        a12 = P['M'] * P['l'] * c
        a22 = P['Ib'] + P['M'] * P['l'] ** 2
        b1 = tau / P['r'] + P['M'] * P['l'] * s * thd ** 2 + self.kick
        b2 = P['M'] * P['g'] * P['l'] * s - tau + self.kick * P['l'] * c
        det = a11 * a22 - a12 * a12
        xdd = (b1 * a22 - a12 * b2) / det
        thdd = (a11 * b2 - a12 * b1) / det
        self.s = [x + v * dt, v + xdd * dt, th + thd * dt, thd + thdd * dt]

    # -- one 200 Hz control tick (mirrors controlStep / runStep) -----------------
    def tick(self):
        p = self.p
        now = self.millis()
        if self.armed:
            lost = now - self.last_cmd > 2000
            if lost or not self.enabled or self.tune or self.fallen:
                self.disarm()
                self.report('Drive locked: control link lost' if lost else 'Drive locked')

        # sensors
        true_deg = math.degrees(self.s[2])
        gyro = math.degrees(self.s[3]) + 0.3 + random.gauss(0, 0.15)
        acc = true_deg + random.gauss(0, 0.3)
        self.rate = gyro
        self.angle = p['alpha'] * (self.angle + gyro * DT) + (1 - p['alpha']) * acc
        self.rate_f = p['dlpf'] * self.rate_f + (1 - p['dlpf']) * gyro

        dc, tc = self.drive, self.turn
        if not self.armed or self.tune or now - self.last_cmd > 600:
            dc = tc = 0.0
        self.drive_sm += clamp(dc - self.drive_sm, -1.5 * DT, 1.5 * DT)
        self.turn_sm += clamp(tc - self.turn_sm, -4 * DT, 4 * DT)

        pwm_l = pwm_r = 0
        if self.mode == 'balancing':
            if not self.enabled:
                self.mode = 'idle'
                self.report('Motors disabled')
            elif abs(self.angle - p['trim']) > 40:
                self.mode = 'idle'
                self.fallen = True
                self.arm_ticks = 0
                self.report('Fallen: motors off. Stand it upright to resume')
            else:
                if abs(self.u) < 250:
                    self.v_est += (self.u / 255 - self.v_est) * DT / p['tauv']
                self.run_ticks += 1
                ks = p['ks'] * min(1.0, self.run_ticks / (1.5 / DT))
                v_err = self.drive_sm * p['vmax'] - self.v_est
                self.auto_trim = clamp(self.auto_trim + p['kis'] * v_err * DT, -p['lean'], p['lean'])
                self.tgt = p['trim'] + clamp(self.auto_trim + ks * v_err, -p['lean'], p['lean'])
                err = self.angle - self.tgt
                self.i_term = clamp(self.i_term + p['ki'] * err * DT, -120, 120)
                u = clamp(p['kp'] * err + self.i_term + p['kd'] * self.rate_f, -255, 255)
                if abs(u) >= 250 and abs(self.angle - p['trim']) < 6:
                    self.sat_ticks += 1
                    if self.sat_ticks >= 50:
                        self.sat_ticks = 0
                        self.v_est = self.auto_trim = self.i_term = 0.0
                        self.tgt = p['trim']
                        u = clamp(p['kp'] * (self.angle - self.tgt) + p['kd'] * self.rate_f, -255, 255)
                else:
                    self.sat_ticks = 0
                self.u = u
                tr = self.turn_sm * p['turn']
                pwm_l = self.friction_comp(u + tr)
                pwm_r = self.friction_comp(u - tr)
        elif self.mode == 'motor-test':
            self.mode_ticks += 1
            if self.mode_ticks < 160:
                pwm_l = 140
            elif 240 <= self.mode_ticks < 400:
                pwm_r = 140
            elif self.mode_ticks >= 400:
                self.mode = 'idle'
                self.report('Test done. If a wheel spun backwards: invl / invr')
        elif self.mode == 'calibrating':
            self.mode_ticks += 1
            if self.mode_ticks >= 300:
                self.mode = 'idle'
                self.report('Calibration done (simulated)')
        else:
            self.u = 0.0
            self.tgt = p['trim']
            if self.enabled and self.imu and abs(self.angle - p['trim']) < 3:
                self.arm_ticks += 1
                if self.arm_ticks >= 80:
                    self.i_term = self.v_est = self.auto_trim = self.u = 0.0
                    self.rate_f = self.drive_sm = self.turn_sm = 0.0
                    self.arm_ticks = self.run_ticks = self.sat_ticks = 0
                    self.fallen = False
                    self.mode = 'balancing'
                    self.report('Balancing')
            else:
                self.arm_ticks = 0
        self.pwm_l, self.pwm_r = pwm_l, pwm_r

        # plant (1 kHz) -----------------------------------------------------
        volts = (pwm_l + pwm_r) / 2 / 255 * (PLANT['Vbat'] - PLANT['Vdrop'])
        self.yaw_rate += ((pwm_r - pwm_l) * 0.9 - self.yaw_rate) * DT / 0.15   # positive = turning left, as the gyro reports
        lying = abs(self.s[2]) >= math.radians(70)
        if lying:
            self.s = [self.s[0], 0.0, math.copysign(math.radians(70), self.s[2]), 0.0]
            self.down_ticks += 1
            if self.down_ticks > 500:          # a simulated hand stands it up after 2.5 s
                self.s = [self.s[0], 0.0, math.radians(random.uniform(-1.0, 1.0)), 0.0]
                self.angle = math.degrees(self.s[2])
                self.down_ticks = 0
        else:
            self.down_ticks = 0
            held = self.mode != 'balancing' and abs(self.s[2]) < math.radians(8)
            if held:                           # idle and upright: resting on the hand
                self.s = [self.s[0], 0.0, self.s[2], 0.0]
            else:
                for _ in range(5):
                    self.plant(volts, DT / 5)
        self.kick *= 0.9

        self.tick_n += 1
        if self.tick_n % SAMPLE_DIV == 0 and self.mode != 'calibrating':
            roll = random.gauss(0, 0.15)
            self.samples.append([now, round(self.angle * 100), round(self.tgt * 100), round(self.rate * 10),
                                 round(self.u), pwm_l, pwm_r, round(self.v_est * 1000), round(roll * 100),
                                 round(self.yaw_rate * 10)])
            self.head += 1
            if len(self.samples) > 128:
                del self.samples[:-128]

    def run(self):
        nxt = time.perf_counter()
        while True:
            now = time.perf_counter()
            n = 0
            with self.lock:
                while nxt <= now and n < 60:
                    self.tick()
                    nxt += DT
                    n += 1
            if n == 60:
                nxt = now
            time.sleep(0.003)

    # -- HTTP API -----------------------------------------------------------
    def telemetry(self, since, msg_since):
        with self.lock:
            head = self.head
            if since > head or head - since > 32:
                since = max(0, head - 32)
            count = head - since
            data = self.samples[len(self.samples) - count:] if count else []
            mq = len(self.msgs)
            mcount = mq - msg_since
            if msg_since > mq or mcount > 8:
                mcount = min(8, mq)
            return dict(n=head, d=data, m='fallen' if (self.mode == 'idle' and self.fallen) else self.mode,
                        e=int(self.enabled), imu=int(self.imu), arm=int(self.armed), own=self.owner,
                        tune=int(self.tune), fall=int(self.fallen), rp=self.ramp_pwm, lu=540 + random.randint(0, 40),
                        up=self.millis() // 1000, st=1, pv=hash(json.dumps(self.p, sort_keys=True)) & 0xFFFF,
                        mq=mq, ms=self.msgs[mq - mcount:] if mcount else [])

    def joy(self, v, t, client):
        with self.lock:
            if self.armed and client and client == self.owner:
                self.drive = clamp(v, -1, 1)
                self.turn = clamp(t, -1, 1)
                self.last_cmd = self.millis()

    def state(self):
        with self.lock:
            return dict(fw='2.0.0', ssid='BalanceBot-SIM', sim=1, loopHz=200, sampleHz=50, batt=0, imuAddr=104,
                        fallAngle=40, p=dict(self.p, invl=self.invl, invr=self.invr))

    def command(self, line, client):
        words = line.lower().replace('=', ' ').split()
        if not words:
            return ''
        cmd, arg = words[0], (words[1] if len(words) > 1 else None)
        with self.lock:
            if cmd == 'on':
                self.enabled = True
                return 'Balancing enabled: stand it upright'
            if cmd == 'off':
                self.enabled = False
                self.tune = False
                return 'Balancing disabled'
            if cmd == 'estop':
                self.enabled = False
                self.tune = False
                self.disarm()
                if self.mode != 'balancing':
                    self.mode = 'idle'
                self.report('E-STOP: balancing disabled')
                return 'E-STOP'
            if cmd == 'arm':
                if not self.enabled or not self.imu or self.tune or self.fallen:
                    return 'Cannot unlock driving: balancing must be on and the robot upright (IMU ok, autotune off)'
                self.drive = self.turn = 0.0
                self.last_cmd = self.millis()
                self.owner = client
                self.armed = True
                return 'Drive armed'
            if cmd == 'disarm':
                self.disarm()
                return 'Drive locked'
            if cmd in ('autotune', 'at'):
                self.tune = not (arg in ('stop', 'off', '0'))
                if self.tune:
                    self.enabled = True
                    self.report('Autotune ON (simulated: gains are not changed)')
                    return 'Autotune starting: stand the robot upright and let go'
                return 'Stopping autotune'
            if cmd == 'save':
                if self.mode == 'balancing':
                    return "Cannot save while balancing: send 'off' first"
                self.saved = dict(self.p)
                return 'Saved'
            if cmd == 'load':
                self.p = dict(self.saved)
                return 'Parameters reloaded from memory'
            if cmd == 'reset':
                self.p = dict(PARAMS)
                return 'Default PID values (calibration kept, not saved)'
            if cmd in ('calg', 'calup', 'calfwd'):
                self.enabled = False
                self.mode = 'calibrating'
                self.mode_ticks = 0
                return "Calibration started (balancing disabled: send 'on' afterwards)"
            if cmd == 'mt':
                self.enabled = False
                self.mode = 'motor-test'
                self.mode_ticks = 0
                self.report('Test: LEFT wheel FORWARD')
                return 'Motor test: lift the wheels off the ground'
            if cmd == 'ramp':
                self.enabled = False
                self.ramp_pwm = 30
                return 'Ramp: hold the robot upright on the floor and send \'ok\' when the wheels start turning'
            if cmd == 'ok':
                self.p['minpwm'] = 32.0
                self.report("minpwm = 32 (use 'save' to store it)")
                return ''
            if cmd == 'stop':
                self.mode = 'idle'
                return 'Stopped'
            if cmd == 'invl':
                self.invl ^= 1
                return 'invl=%d' % self.invl
            if cmd == 'invr':
                self.invr ^= 1
                return 'invr=%d' % self.invr
            if cmd == 'kick':                  # simulator only: push the robot
                self.kick = float(arg or 8.0)
                return 'kick'
            if cmd == 'info':
                return 'mode=%s balance=%s imu=ok angle=%.2f (simulated)' % (self.mode, 'on' if self.enabled else 'off', self.angle)
            if cmd in self.p:
                if arg is not None:
                    try:
                        v = float(arg)
                    except ValueError:
                        return 'Not a number'
                    lo, hi = LIMITS[cmd]
                    if not lo <= v <= hi:
                        return 'Out of range: %.3f .. %.3f' % (lo, hi)
                    self.p[cmd] = v
                return '%s=%.4f' % (cmd, self.p[cmd])
            return 'Unknown command: %s  (type help)' % cmd


class Handler(BaseHTTPRequestHandler):
    robot = None        # SimRobot, or None in bridge mode
    target = None       # robot base URL in bridge mode

    def log_message(self, *args):
        pass

    def reply(self, code, ctype, body, headers=()):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(url.query)
        arg = lambda k, d='0': q.get(k, [d])[0]
        if url.path == '/':
            return self.reply(302, 'text/plain', b'', [('Location', '/control')])
        if url.path in ('/t', '/j', '/c', '/s'):
            if self.robot is None:
                return self.proxy()
            no_store = [('Cache-Control', 'no-store')]
            if url.path == '/s':
                return self.reply(200, 'application/json', json.dumps(self.robot.state()).encode(), no_store)
            if url.path == '/c':
                text = self.robot.command(arg('q', ''), max(2, int(arg('c'))))
                return self.reply(200, 'text/plain', text.encode(), no_store)
            if url.path == '/j':
                self.robot.joy(float(arg('v')), float(arg('t')), int(arg('c')))
            body = json.dumps(self.robot.telemetry(int(arg('s')), int(arg('m'))), separators=(',', ':'))
            return self.reply(200, 'application/json', body.encode(), no_store)
        assets = build_web.build()
        for i, a in enumerate(assets):
            if url.path == a['path'] or (i == 0 and url.path == '/statistics'):
                headers = [('Cache-Control', 'public, max-age=31536000, immutable' if a['immutable'] else 'no-cache')]
                if a['gzip']:
                    headers.append(('Content-Encoding', 'gzip'))
                return self.reply(200, a['type'], a['data'], headers)
        self.reply(404, 'text/plain', b'not found')

    def proxy(self):
        try:
            with urllib.request.urlopen(self.target + self.path, timeout=1.5) as r:
                self.reply(r.status, r.headers.get('Content-Type', 'text/plain'), r.read(), [('Cache-Control', 'no-store')])
        except (urllib.error.URLError, OSError) as e:
            self.reply(504, 'text/plain', ('robot not reachable: %s' % e).encode())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--robot', help='bridge to a real robot, e.g. http://192.168.4.1')
    ap.add_argument('--port', type=int, default=8080)
    ap.add_argument('--host', default='127.0.0.1')
    args = ap.parse_args()
    if args.robot:
        Handler.target = args.robot.rstrip('/')
        print('Bridge to the robot at %s' % Handler.target)
    else:
        Handler.robot = SimRobot()
        threading.Thread(target=Handler.robot.run, daemon=True).start()
        print('Simulated robot (no hardware involved)')
    print('Open http://localhost:%d/control and http://localhost:%d/statistics' % (args.port, args.port))
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
