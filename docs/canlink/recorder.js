// 录制：帧按列存进小块，满了转成 Blob（浏览器内存紧张时会放到磁盘），
// 保存时按时间段生成 Vector ASC。浏览器和 Node（自测）通用。
const Recorder = (() => {
  const CHUNK = 32768;                          // 每块帧数
  const HDR = 16;                               // 每帧头：t(8) id(4) len(1) flags(1) ch(1) dlc(1)
  // flags：1=发送 2=CAN FD 4=远程帧 8=BRS 16=扩展帧 32=ESI

  const MARK_ID = 0x1FFFFFF0;   // 标记帧 ID（29 位扩展帧）。CANalyzer 离线不导入文件里的标记，
                                // 改在标记时刻记一帧普通报文，Trace 里按 ID 过滤即可定位。
  function markerFrame(t, no, ch) {   // t：相对秒；no：标记序号（从 1）；ch：跟随最近一帧的通道
    const data = new Uint8Array(8);
    const dv = new DataView(data.buffer);
    dv.setUint16(0, no, true);                    // B0–B1 标记序号（小端）
    data[2] = 0xA5;                               // B2 签名；B3 = 0
    dv.setUint32(4, Math.round(t * 1000), true);  // B4–B7 标记时刻（相对录制开始的毫秒，小端）
    return { id: MARK_ID, ext: true, fd: false, tx: false, rtr: false, brs: false, esi: false, ch: ch || 1, dlc: 8, data };
  }

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
      let lastCh = 1;
      await this.forEach(from, to, f => {
        while (mi < marks.length && marks[mi].t <= f.t) { const rt = marks[mi].t - base; buf += ASC.comment(rt, marks[mi].label); buf += ASC.line(rt, markerFrame(rt, mi + 1, lastCh)); mi++; }
        buf += ASC.line(f.t - base, f); lastCh = f.ch || 1;
        if (buf.length > 1 << 20) flush();
      });
      while (mi < marks.length) { const rt = marks[mi].t - base; buf += ASC.comment(rt, marks[mi].label); buf += ASC.line(rt, markerFrame(rt, mi + 1, lastCh)); mi++; }
      buf += 'End TriggerBlock\n';
      flush();
      return new Blob(parts, { type: 'text/plain' });
    }

    // 生成 BLF（Blob）。from/to：秒；时间从 from 开始重新计（与 toASC 一致）。标记写成 BLF 全局标记，并附一帧标记帧。
    async toBLF(from = 0, to = Infinity) {
      const base = Number.isFinite(from) && from > 0 ? from : 0;
      const startAbs = Math.floor((this.startDate.getTime() / 1000 + base) * 1000) / 1000;
      const marks = this.marks.filter(m => m.t >= from && m.t <= to);
      let mi = 0, lastT = 0, lastCh = 1;
      const w = new BLF.Writer(startAbs);
      await this.forEach(from, to, f => {
        while (mi < marks.length && marks[mi].t <= f.t) { const rt = marks[mi].t - base; w.marker(rt, marks[mi].label); w.frame(rt, markerFrame(rt, mi + 1, lastCh)); mi++; }
        w.frame(f.t - base, f); lastT = f.t - base; lastCh = f.ch || 1;
      });
      while (mi < marks.length) { const rt = marks[mi].t - base; w.marker(rt, marks[mi].label); w.frame(rt, markerFrame(rt, mi + 1, lastCh)); mi++; }
      return w.finish(lastT);
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

  // ---- Vector BLF 二进制日志 ----
  // 布局与 python-can 的 BLFWriter 对齐（文件头 / 对象头 V1 纳秒时间戳 / 128KB 一个 LogContainer、
  // zlib 压缩），CANalyzer、python-can、SEF 的 canlog.js 都能读。浏览器里用 CompressionStream 压缩，
  // 没有这个能力时退回不压缩（容器方式 0，仍是合法 BLF）。
  const BLF = (() => {
    const MAXC = 128 * 1024;
    const sig = (dv, off, txt) => { for (let i = 0; i < 4; i++) dv.setUint8(off + i, txt.charCodeAt(i)); };
    function sysTime(epochSec) {
      if (!epochSec || epochSec < 631152000) return [0, 0, 0, 0, 0, 0, 0, 0];
      const d = new Date(Math.round(epochSec * 1000));
      return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDay(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()];
    }
    async function deflate(data) {
      try {
        if (typeof CompressionStream !== 'undefined') {
          const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
          return new Uint8Array(await new Response(stream).arrayBuffer());
        }
      } catch (e) { /* 退回不压缩 */ }
      try { if (typeof require !== 'undefined') return new Uint8Array(require('zlib').deflateSync(data)); } catch (e) { /* 退回不压缩 */ }
      return null;
    }
    class Writer {
      constructor(startAbs) { this.startAbs = startAbs; this.pieces = []; this.len = 0; this.count = 0; }
      _obj(type, data, tsSec) {
        const dv = new DataView(new ArrayBuffer(32));
        sig(dv, 0, 'LOBJ');
        dv.setUint16(4, 32, true); dv.setUint16(6, 1, true);
        dv.setUint32(8, 32 + data.length, true); dv.setUint32(12, type, true);
        dv.setUint32(16, 2, true); // 时间戳单位：纳秒
        dv.setBigUint64(24, BigInt(Math.max(0, Math.round(tsSec * 1e9))), true);
        this.pieces.push(new Uint8Array(dv.buffer), data);
        let n = 32 + data.length;
        const pad = data.length % 4;
        if (pad) { this.pieces.push(new Uint8Array(pad)); n += pad; }
        this.len += n; this.count++;
      }
      frame(t, f) {
        const flags = (f.tx ? 1 : 0) | (f.rtr ? 0x80 : 0);
        const id = (f.id >>> 0) | (f.ext ? 0x80000000 : 0);
        if (f.fd) {
          // CanFdMessage 84 字节：通道/标志/DLC/ID/帧长/位计数(1字节)/FD标志@13/有效字节数@14/数据@20
          const dv = new DataView(new ArrayBuffer(84));
          dv.setUint16(0, f.ch || 1, true); dv.setUint8(2, flags); dv.setUint8(3, f.dlc);
          dv.setUint32(4, id, true);
          dv.setUint8(13, 1 | (f.brs ? 2 : 0) | (f.esi ? 4 : 0)); // EDL | BRS | ESI
          dv.setUint8(14, f.data.length);
          new Uint8Array(dv.buffer).set(f.data.subarray(0, 64), 20);
          this._obj(100, new Uint8Array(dv.buffer), t);
        } else {
          const dv = new DataView(new ArrayBuffer(16));
          dv.setUint16(0, f.ch || 1, true); dv.setUint8(2, flags); dv.setUint8(3, f.dlc);
          dv.setUint32(4, id, true);
          new Uint8Array(dv.buffer).set(f.data.subarray(0, 8), 8);
          this._obj(1, new Uint8Array(dv.buffer), t);
        }
      }
      marker(t, label) {
        const enc = new TextEncoder();
        const g = enc.encode(String(label || '')), m = enc.encode('canlink'), c = enc.encode('Added by canlink');
        const dv = new DataView(new ArrayBuffer(40));
        dv.setUint32(4, 0xFFFFFF, true); dv.setUint32(8, 0xFF3300, true);
        dv.setUint32(16, g.length, true); dv.setUint32(20, m.length, true); dv.setUint32(24, c.length, true);
        const data = new Uint8Array(40 + g.length + m.length + c.length);
        data.set(new Uint8Array(dv.buffer)); data.set(g, 40); data.set(m, 40 + g.length); data.set(c, 40 + g.length + m.length);
        this._obj(96, data, t);
      }
      async finish(lastT) {
        const all = new Uint8Array(this.len);
        let o = 0;
        for (const p of this.pieces) { all.set(p, o); o += p.length; }
        const containers = [];
        let fileSize = 144, uSize = 144, off = 0;
        while (off < all.length) {
          const chunk = all.subarray(off, off + MAXC);
          const comp = await deflate(chunk);
          const payload = comp || chunk, method = comp ? 2 : 0;
          const objSize = 32 + payload.length;
          const dv = new DataView(new ArrayBuffer(32));
          sig(dv, 0, 'LOBJ');
          dv.setUint16(4, 16, true); dv.setUint16(6, 1, true);
          dv.setUint32(8, objSize, true); dv.setUint32(12, 10, true);
          dv.setUint16(16, method, true); dv.setUint32(24, chunk.length, true);
          containers.push(new Uint8Array(dv.buffer), payload);
          const pad = objSize % 4;
          if (pad) containers.push(new Uint8Array(pad));
          fileSize += objSize + pad; uSize += 32 + chunk.length;
          off += chunk.length;
        }
        const fh = new DataView(new ArrayBuffer(144));
        sig(fh, 0, 'LOGG');
        fh.setUint32(4, 144, true); fh.setUint8(8, 5);
        fh.setUint8(12, 2); fh.setUint8(13, 6); fh.setUint8(14, 8); fh.setUint8(15, 1);
        fh.setBigUint64(16, BigInt(fileSize), true);
        fh.setBigUint64(24, BigInt(uSize), true);
        fh.setUint32(32, this.count, true);
        sysTime(this.startAbs).forEach((v, i) => fh.setUint16(40 + i * 2, v, true));
        sysTime(this.startAbs + (lastT || 0)).forEach((v, i) => fh.setUint16(56 + i * 2, v, true));
        return new Blob([new Uint8Array(fh.buffer), ...containers], { type: 'application/octet-stream' });
      }
    }
    return { Writer };
  })();

  Recorder.ASC = ASC;
  Recorder.BLF = BLF;
  return Recorder;
})();
if (typeof module !== 'undefined') module.exports = Recorder;
