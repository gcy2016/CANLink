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
    // 演示用诊断控制器：ISO-TP 重组请求，按服务回应答（内容是编的，跟任何车型无关）
    diag(data) {
      const RESP = 0x7E8;
      const type = data[0] >> 4;
      if (type === 3) {  // 我们多帧应答时，对方回的流控：把剩下的连续帧发出去
        if (this._cf) { const cf = this._cf; this._cf = null; for (const fr of cf) this.send(this.frameLine({ id: RESP, data: fr, us: this.us() }, false)); }
        return;
      }
      let req;
      if (type === 0) { const nn = data[0] & 0x0F; req = data.slice(1, 1 + nn); }
      else if (type === 1) { this._rx = { n: ((data[0] & 0x0F) << 8) | data[1], buf: [...data.slice(2)] }; this.send(this.frameLine({ id: RESP, data: Uint8Array.of(0x30, 0, 0), us: this.us() }, false)); return; }
      else if (type === 2) { if (!this._rx) return; this._rx.buf.push(...data.slice(1)); if (this._rx.buf.length >= this._rx.n) { req = Uint8Array.from(this._rx.buf.slice(0, this._rx.n)); this._rx = null; } else return; }
      if (!req || !req.length) return;
      const sid = req[0];
      // 带“抑制正响应”位（子功能 bit7=1，如 10 83 / 28 83 / 85 82 / 3E 80）的，真实 ECU 不回应答
      if ([0x10, 0x11, 0x28, 0x85, 0x3E].includes(sid) && (req[1] & 0x80)) return;
      let p;
      if (sid === 0x10) p = [0x50, req[1], 0x00, 0x32, 0x01, 0xF4];
      else if (sid === 0x11) p = [0x51, req[1]];
      else if (sid === 0x3E) p = [0x7E, req[1] || 0];
      else if (sid === 0x14) p = [0x54];
      else if (sid === 0x19) p = [0x59, req[1] || 0x02, 0xFF, 0x50, 0x1F, 0x00, 0x09, 0xC1, 0x23, 0x45, 0x08, 0xE1, 0x5F, 0x00, 0x01];
      else if (sid === 0x22) p = [0x62, req[1], req[2], 0x01, 0x23];
      else if (sid === 0x2E) p = [0x6E, req[1], req[2]];
      else if (sid === 0x31) p = [0x71, req[1], req[2], req[3], 0x00];
      else if (sid === 0x34) p = [0x74, 0x20, 0x00, 0x82];   // 请求下载：支持，每块最多 0x0082=130 字节
      else if (sid === 0x36) p = [0x76, req[1]];             // 传输数据：回块序号
      else if (sid === 0x37) p = [0x77];                     // 退出传输
      else if (sid === 0x27 && (req[1] & 1)) p = [0x67, req[1], 0x11, 0x22, 0x33, 0x44];
      else if (sid === 0x27) p = [0x67, req[1]];
      else p = [0x7F, sid, 0x11];
      setTimeout(() => this.sendResp(RESP, p), 5);
    }
    sendResp(id, payload) {
      const p = Uint8Array.from(payload);
      if (p.length <= 7) { const d = new Uint8Array(8); d[0] = p.length; d.set(p, 1); this.send(this.frameLine({ id, data: d, us: this.us() }, false)); return; }
      // 多帧：首帧 + 连续帧（等对方流控）
      const ff = new Uint8Array(8); ff[0] = 0x10 | ((p.length >> 8) & 0x0F); ff[1] = p.length & 0xFF; ff.set(p.subarray(0, 6), 2);
      const cf = []; let off = 6, sn = 1;
      while (off < p.length) { const d = new Uint8Array(8); d[0] = 0x20 | (sn & 0x0F); d.set(p.subarray(off, off + 7), 1); cf.push(d); off += 7; sn++; }
      this._cf = cf;
      this.send(this.frameLine({ id, data: ff, us: this.us() }, false));
    }
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
          // 模拟一个会 ISO-TP 应答的诊断控制器（请求 7E0 / 功能 7DF → 响应 7E8）
          if (!ext && (id === 0x7E0 || id === 0x7DF)) this.diag(data);
        }
      }
    }
    async close() { clearInterval(this.timer); this.on = false; }
  }
  return DemoTransport;
})();
if (typeof module !== 'undefined') module.exports = DemoTransport;
