// 录制：帧按列存进小块，满了转成 Blob（浏览器内存紧张时会放到磁盘），
// 保存时按时间段生成 Vector ASC。浏览器和 Node（自测）通用。
const Recorder = (() => {
  const CHUNK = 32768;                          // 每块帧数
  const HDR = 16;                               // 每帧头：t(8) id(4) len(1) flags(1) ch(1) dlc(1)
  // flags：1=发送 2=CAN FD 4=远程帧 8=BRS 16=扩展帧 32=ESI

  class Recorder {
    constructor() {
      this.blobs = [];           // 已封存的块：{ blob, n, t0, t1 }
      this.marks = [];           // { t, label }
      this.count = 0;
      this.startDate = new Date();
      this.newChunk();
    }
    newChunk() {
      this.hdr = new DataView(new ArrayBuffer(CHUNK * HDR));
      this.data = new Uint8Array(CHUNK * 16);
      this.dlen = 0; this.n = 0; this.t0 = null; this.t1 = 0;
    }
    push(t, f) {
      const len = f.data.length;
      if (this.n === CHUNK) this.seal();
      if (this.dlen + len > this.data.length) {
        const d = new Uint8Array(this.data.length * 2); d.set(this.data.subarray(0, this.dlen)); this.data = d;
      }
      const o = this.n * HDR, h = this.hdr;
      h.setFloat64(o, t, true);
      h.setUint32(o + 8, f.id, true);
      h.setUint8(o + 12, len);
      h.setUint8(o + 13, (f.tx ? 1 : 0) | (f.fd ? 2 : 0) | (f.rtr ? 4 : 0) | (f.brs ? 8 : 0) | (f.ext ? 16 : 0) | (f.esi ? 32 : 0));
      h.setUint8(o + 14, f.ch || 1);
      h.setUint8(o + 15, f.dlc);
      this.data.set(f.data, this.dlen); this.dlen += len;
      if (this.t0 === null) this.t0 = t;
      this.t1 = t; this.n++; this.count++;
    }
    seal() {
      if (!this.n) return;
      const parts = [new Uint8Array(this.hdr.buffer, 0, this.n * HDR), this.data.slice(0, this.dlen)];
      this.blobs.push({ blob: new Blob(parts), n: this.n, hlen: this.n * HDR, t0: this.t0, t1: this.t1 });
      this.newChunk();
    }
    mark(t, label) { this.marks.push({ t, label: label || `Mark ${this.marks.length + 1}` }); }
    get duration() { return this.count ? this.t1Last() : 0; }
    t1Last() { return this.n ? this.t1 : (this.blobs.length ? this.blobs[this.blobs.length - 1].t1 : 0); }

    // 逐帧遍历 [from, to] 秒内的帧
    async forEach(from, to, fn) {
      const visit = (hdr, data, n) => {
        let off = 0;
        for (let i = 0; i < n; i++) {
          const o = i * HDR, t = hdr.getFloat64(o, true), len = hdr.getUint8(o + 12);
          if (t >= from && t <= to) {
            const fl = hdr.getUint8(o + 13);
            fn({
              t, id: hdr.getUint32(o + 8, true), ch: hdr.getUint8(o + 14), dlc: hdr.getUint8(o + 15),
              tx: !!(fl & 1), fd: !!(fl & 2), rtr: !!(fl & 4), brs: !!(fl & 8), ext: !!(fl & 16), esi: !!(fl & 32),
              data: data.subarray(off, off + len),
            });
          }
          off += len;
        }
      };
      for (const b of this.blobs) {
        if (b.t1 < from || b.t0 > to) continue;
        const buf = new Uint8Array(await b.blob.arrayBuffer());
        visit(new DataView(buf.buffer, 0, b.hlen), buf.subarray(b.hlen), b.n);
      }
      if (this.n && !(this.t1 < from || this.t0 > to)) visit(this.hdr, this.data, this.n);
    }

    // 生成 ASC（Blob）。from/to：秒；时间从 from 开始重新计。
    async toASC(from = 0, to = Infinity, opt = {}) {
      const parts = [];
      let buf = '';
      const flush = () => { parts.push(buf); buf = ''; };
      const date = new Date(this.startDate.getTime() + Math.max(0, from) * 1000);
      buf += ASC.header(date, opt.comment);
      const base = Number.isFinite(from) && from > 0 ? from : 0;
      const marks = this.marks.filter(m => m.t >= from && m.t <= to);
      let mi = 0;
      await this.forEach(from, to, f => {
        while (mi < marks.length && marks[mi].t <= f.t) { buf += ASC.comment(marks[mi].t - base, marks[mi].label); mi++; }
        buf += ASC.line(f.t - base, f);
        if (buf.length > 1 << 20) flush();
      });
      while (mi < marks.length) { buf += ASC.comment(marks[mi].t - base, marks[mi].label); mi++; }
      buf += 'End TriggerBlock\n';
      flush();
      return new Blob(parts, { type: 'text/plain' });
    }
  }

  // ---- Vector ASC 文本 ----
  const ASC = {
    date(d) {
      const W = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      let h = d.getHours();
      const ap = h >= 12 ? 'pm' : 'am';
      h = h % 12 || 12;
      const p2 = v => String(v).padStart(2, '0');
      return `${W[d.getDay()]} ${M[d.getMonth()]} ${p2(d.getDate())} ${p2(h)}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')} ${ap} ${d.getFullYear()}`;
    },
    header(d, comment) {
      const ds = ASC.date(d);
      return `date ${ds}\nbase hex  timestamps absolute\ninternal events logged\n// version 10.0.0\n` +
        (comment ? `// ${comment}\n` : '') +
        `Begin Triggerblock ${ds}\n   0.000000 Start of measurement\n`;
    },
    time(t) { return t.toFixed(6).padStart(11, ' '); },
    hex(v, w) { return v.toString(16).toUpperCase().padStart(w || 2, '0'); },
    comment(t, label) { return `// ${ASC.time(t).trim()} ${String(label).replace(/[\r\n]/g, ' ')}\n`; },
    line(t, f) {
      const id = f.id.toString(16).toUpperCase() + (f.ext ? 'x' : '');
      const dir = f.tx ? 'Tx' : 'Rx';
      const bytes = Array.from(f.data, b => ASC.hex(b)).join(' ');
      if (!f.fd) {
        if (f.rtr) return `${ASC.time(t)} ${f.ch} ${id.padEnd(15)} ${dir}   r ${ASC.hex(f.dlc, 1)}\n`;
        return `${ASC.time(t)} ${f.ch} ${id.padEnd(15)} ${dir}   d ${f.data.length} ${bytes}\n`;
      }
      // CANFD 行（与 CANalyzer / python-can 相同的列）：
      // 通道 方向 ID 报文名 BRS ESI DLC 长度 数据 时长 位数 标志 CRC 位时间×4
      const flags = 0x1000 | (f.brs ? 0x2000 : 0) | (f.esi ? 0x4000 : 0);
      return `${ASC.time(t)} CANFD ${String(f.ch).padStart(3)} ${dir} ${id.padStart(8)} ${''.padStart(32)} ` +
        `${f.brs ? 1 : 0} ${f.esi ? 1 : 0} ${ASC.hex(f.dlc, 1)} ${String(f.data.length).padStart(2)} ${bytes}` +
        `${bytes ? ' ' : ''}${'0'.padStart(8)} ${'0'.padStart(4)} ${ASC.hex(flags, 8)} ${'0'.padStart(8)} ` +
        `${'0'.padStart(8)} ${'0'.padStart(8)} ${'0'.padStart(8)} ${'0'.padStart(8)}\n`;
    },
  };

  Recorder.ASC = ASC;
  return Recorder;
})();
if (typeof module !== 'undefined') module.exports = Recorder;
