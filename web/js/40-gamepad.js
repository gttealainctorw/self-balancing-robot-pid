// Xbox (or any standard-mapping) controller through the browser Gamepad API.
// Path: controller -> operating system -> browser -> this page -> the same
// /j command the on-screen joystick uses. The controller never talks to the
// robot directly.

const PAD_BUTTONS = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'L stick', 'R stick',
  'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'Xbox'];
const PAD_ACTIONS = { arm: 'Arm drive', disarm: 'Lock drive', estop: 'E-STOP', balance: 'Balance on' };

// onEvent(name): 'found', 'lost', 'mapped', or an action key from PAD_ACTIONS.
function Pad(onEvent) {
  const pad = {
    supported: typeof navigator.getGamepads === 'function',
    blocked: false,            // the browser refused access (insecure origin or policy)
    connected: false, id: '', standard: true,
    x: 0, y: 0, boost: 0, precision: 0,
    axes: [0, 0, 0, 0], buttons: [],
    capture: null,             // action waiting for "press a button"
    prev: [],

    poll() {
      if (!this.supported) return;
      let list = [];
      try { list = navigator.getGamepads() || []; } catch (e) { this.blocked = true; this.supported = false; return; }
      let gp = null;
      for (const g of list) {
        if (g && g.connected && (!gp || (g.mapping === 'standard' && gp.mapping !== 'standard'))) gp = g;
      }
      if (!gp) {
        if (this.connected) {
          this.connected = false;
          this.x = this.y = this.boost = this.precision = 0;
          this.buttons = [];
          onEvent('lost');
        }
        return;
      }
      const down = gp.buttons.map(b => b.pressed || b.value > 0.5);
      if (!this.connected) {
        this.connected = true;
        this.id = gp.id;
        this.standard = gp.mapping === 'standard';
        this.prev = down;       // buttons already held when it connected do not fire
        onEvent('found');
      }
      const cfg = Settings.data, ax = gp.axes;
      this.axes = [ax[0] || 0, ax[1] || 0, ax[2] || 0, ax[3] || 0];
      this.x = cfg.padLayout === 'single' ? this.axes[0] : this.axes[2];
      this.y = (cfg.padInvertY ? 1 : -1) * this.axes[1];
      this.boost = gp.buttons[7] ? gp.buttons[7].value : 0;
      this.precision = gp.buttons[6] ? gp.buttons[6].value : 0;
      this.buttons = gp.buttons.map(b => b.value || (b.pressed ? 1 : 0));
      for (let i = 0; i < down.length; i++) {
        if (down[i] && !this.prev[i]) {
          if (this.capture) {
            cfg.padButtons[this.capture] = i;
            this.capture = null;
            Settings.save();
            onEvent('mapped');
          } else {
            for (const action in cfg.padButtons) if (cfg.padButtons[action] === i) onEvent(action);
          }
        }
      }
      this.prev = down;
    },
  };
  return pad;
}

// Line drawing of the controller. Elements carry data-b (button index) or
// data-stick so paintPad() can light them up.
function padSvg() {
  const btn = (i, cx, cy, r, label) =>
    `<g data-b="${i}"><circle cx="${cx}" cy="${cy}" r="${r}"/>${label ? `<text x="${cx}" y="${cy + 3.5}">${label}</text>` : ''}</g>`;
  return `<svg class="pad-svg" viewBox="0 0 320 190" role="img" aria-label="Controller">
<path class="pad-body" d="M92 44h136c30 0 52 22 60 62l10 50c4 20-18 30-32 14l-30-34H104l-30 34c-14 16-36 6-32-14l10-50c8-40 30-62 60-62z"/>
<g data-b="6" class="pad-trig"><rect x="64" y="14" width="46" height="12" rx="6"/><text x="87" y="24">LT</text></g>
<g data-b="7" class="pad-trig"><rect x="210" y="14" width="46" height="12" rx="6"/><text x="233" y="24">RT</text></g>
<g data-b="4" class="pad-trig"><rect x="70" y="30" width="54" height="10" rx="5"/><text x="97" y="39">LB</text></g>
<g data-b="5" class="pad-trig"><rect x="196" y="30" width="54" height="10" rx="5"/><text x="223" y="39">RB</text></g>
<circle class="pad-well" cx="110" cy="80" r="20"/><circle class="pad-stick" data-stick="l" cx="110" cy="80" r="11"/>
<circle class="pad-well" cx="196" cy="116" r="20"/><circle class="pad-stick" data-stick="r" cx="196" cy="116" r="11"/>
<g class="pad-dpad"><rect data-b="12" x="124" y="100" width="12" height="12" rx="2"/><rect data-b="13" x="124" y="124" width="12" height="12" rx="2"/>
<rect data-b="14" x="112" y="112" width="12" height="12" rx="2"/><rect data-b="15" x="136" y="112" width="12" height="12" rx="2"/></g>
${btn(0, 232, 96, 9, 'A')}${btn(1, 250, 78, 9, 'B')}${btn(2, 214, 78, 9, 'X')}${btn(3, 232, 60, 9, 'Y')}
${btn(8, 146, 78, 5, '')}${btn(9, 174, 78, 5, '')}${btn(16, 160, 60, 8, '')}
</svg>`;
}

function paintPad(svg, pad) {
  for (const el of svg.querySelectorAll('[data-b]')) {
    const v = pad.buttons[+el.dataset.b] || 0;
    el.style.setProperty('--v', v.toFixed(2));
    el.classList.toggle('on', v > 0.5);
  }
  const l = svg.querySelector('[data-stick="l"]'), r = svg.querySelector('[data-stick="r"]');
  l.setAttribute('transform', `translate(${(pad.axes[0] * 9).toFixed(1)} ${(pad.axes[1] * 9).toFixed(1)})`);
  r.setAttribute('transform', `translate(${(pad.axes[2] * 9).toFixed(1)} ${(pad.axes[3] * 9).toFixed(1)})`);
}
