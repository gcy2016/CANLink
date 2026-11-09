// 演示模式：不接硬件，模拟一个 vdlink 设备（随机生成几路周期报文、响应命令），
// 用来先看界面、做自测。报文内容是编的，跟任何车型无关。
const DemoTransport = (() => {
  const hex = (v, w) => v.toString(16).toUpperCase().padStart(w, '0');

  class DemoTransport {
    constructor() { this.kind = 'demo'; this.onData = null; this.onClose = null; this.name = '演示设备'; }
    async open() {
      this.on = false; this.ts = 0; this.echo = false; this.tsMode = 0; this.silent = false;
      this.t0 = performance.now();
      this.msgs = [
        { id: 0x100, n: 8, period: 10 }, { id: 0x1A0, n: 8, period: 20 }, { id: 0x200, n: 8, period: 50 },
        { id: 0x2F0, n: 4, period: 100 }, { id: 0x18FF10A0, ext: true, n: 8, period: 100 },
        { id: 0x320, n: 32, period: 20, fd: true, brs: true }, { id: 0x401, n: 64, period: 100, fd: true, brs: true },
        { id: 0x500, n: 8, period: 1000 },
      ].map(m => ({ ...m, next: 0, cnt: 0 }));
      this.timer = setInterval(() => this.tick(), 20);
    }
    us() { return Math.floor((performance.now() - this.t0) * 1000) >>> 0; }
    send(s) { if (this.onData) this.onData(s); }
    frameLine(f, tx) {
      let c = f.fd ? (f.brs ? 'b' : 'd') : 't';
      if (f.ext) c = c.toUpperCase();
      const dlc = f.fd ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64].indexOf(f.data.length) : f.data.length;
      let s = (tx ? '>' : '') + c + hex(f.id, f.ext ? 8 : 3) + hex(dlc, 1) + Array.from(f.data, b => hex(b, 2)).join('');
      if (this.tsMode === 2) s += hex(f.us >>> 0, 8);
      else if (this.tsMode === 1) s += hex(Math.floor(f.us / 1000) % 60000, 4);
      return s + '\r';
    }
    tick() {
      if (!this.on) return;
      const now = performance.now() - this.t0;
      let out = '';
      for (const m of this.msgs) {
        while (m.next <= now) {
          m.cnt++;
          const data = new Uint8Array(m.n);
          for (let i = 0; i < m.n; i++) data[i] = (i === 0 ? m.cnt : (m.id >> (i % 3)) + i * 7 + (i === 2 ? Math.round(40 + 30 * Math.sin(m.cnt / 50)) : 0)) & 0xFF;
          out += this.frameLine({ ...m, data, us: Math.floor(m.next * 1000) }, false);
          m.next += m.period;
        }
      }
      if (out) this.send(out);
    }
    reply(ok) { this.send(ok ? '\r' : '\x07'); }
    async write(text) {
      for (const cmd of text.split('\r')) {
        if (!cmd) continue;
        const c = cmd[0];
        if (c === 'x') {
          if (cmd[1] === 'I') this.send('xIvdlink,1.0-demo,80000000\r');
          else if (cmd[1] === 'S') this.send(`xS${this.on ? 1 : 0},${this.silent ? 1 : 0},0000000F,00000000,00000000,0,-420,1,64\r`);
          else if (cmd[1] === 'T') { this.echo = cmd[2] === '1'; this.reply(true); }
          else this.reply(!this.on);
        } else if (c === 'O') {
          this.on = true;
          const now = performance.now() - this.t0;
          for (const m of this.msgs) m.next = now;
        } else if (c === 'C') this.on = false;
        else if (c === 'Z') this.tsMode = +cmd[1];
        else if (c === 'M') this.silent = cmd[1] === '1';
        else if ('tTdDbB'.includes(c) && this.on && !this.silent) {
          const ext = c === c.toUpperCase(), idLen = ext ? 8 : 3;
          const id = parseInt(cmd.substr(1, idLen), 16), dlc = parseInt(cmd[1 + idLen], 16);
          const n = /[dDbB]/.test(c) ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64][dlc] : dlc;
          const data = new Uint8Array(n);
          for (let i = 0; i < n; i++) data[i] = parseInt(cmd.substr(2 + idLen + 2 * i, 2), 16);
          const f = { id, ext, fd: /[dDbB]/.test(c), brs: /[bB]/.test(c), data, us: this.us() };
          if (this.echo) this.send(this.frameLine(f, true));
          // 模拟一个会应答诊断请求的控制器：请求 ID + 8 回一帧
          if (!ext && id >= 0x700 && id <= 0x7F7 && n >= 2) {
            setTimeout(() => {
              const resp = new Uint8Array(f.fd ? 8 : 8).fill(0xAA);
              resp[0] = 0x03; resp[1] = 0x7F; resp[2] = data[1]; resp[3] = 0x11;
              this.send(this.frameLine({ id: id + 8, ext: false, fd: false, data: resp, us: this.us() }, false));
            }, 5);
          }
        }
      }
    }
    async close() { clearInterval(this.timer); this.on = false; }
  }
  return DemoTransport;
})();
if (typeof module !== 'undefined') module.exports = DemoTransport;
