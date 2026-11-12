// slcan 协议（CANable 2.0 / vdlink 固件）：位时间计算、命令生成、接收行解析。
// 纯函数，浏览器和 Node（自测）通用。
const Slcan = (() => {
  const FD_LEN = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];
  const LEN_DLC = n => { for (let i = 0; i < 16; i++) if (FD_LEN[i] >= n) return i; return -1; };

  // FDCAN 寄存器允许的范围（单位：tq）
  const LIMIT = {
    nominal: { brp: [1, 512], tseg1: [2, 256], tseg2: [2, 128], sjw: 128 },
    data: { brp: [1, 32], tseg1: [1, 32], tseg2: [1, 16], sjw: 16 },
  };

  // 按波特率和采样点算位时间。clock：CAN 时钟（vdlink 为 80 MHz）。
  // 返回 { brp, tseg1, tseg2, sjw, tq, bitrate, sp } 或 null（这个时钟下凑不出整数）。
  function timing(clock, bitrate, sp, kind) {
    const L = LIMIT[kind];
    let best = null;
    for (let brp = L.brp[0]; brp <= L.brp[1]; brp++) {
      const tq = clock / (brp * bitrate);
      if (Math.abs(tq - Math.round(tq)) > 1e-9) continue;
      const n = Math.round(tq);
      if (n < 4 || n > 1 + L.tseg1[1] + L.tseg2[1]) continue;
      let t1 = Math.round(sp * n) - 1;
      t1 = Math.min(Math.max(t1, L.tseg1[0]), L.tseg1[1]);
      let t2 = n - 1 - t1;
      if (t2 < L.tseg2[0]) { t2 = L.tseg2[0]; t1 = n - 1 - t2; }
      if (t2 > L.tseg2[1]) { t2 = L.tseg2[1]; t1 = n - 1 - t2; }
      if (t1 < L.tseg1[0] || t1 > L.tseg1[1]) continue;
      const real = (1 + t1) / n;
      const cand = { brp, tseg1: t1, tseg2: t2, sjw: Math.min(t2, L.sjw), tq: n, bitrate, sp: real };
      const err = Math.abs(real - sp);
      // 采样点最接近的优先；一样接近时取 tq 多的（分辨率高、SJW 大）
      if (!best || err < best.err - 1e-9 || (Math.abs(err - best.err) < 1e-9 && n > best.tq)) best = { ...cand, err };
      if (kind === 'data' && brp >= 2 && best && best.err < 0.01) break; // 数据段尽量用小分频（延时补偿要求）
    }
    if (!best) return null;
    delete best.err;
    return best;
  }

  const timingCmd = (kind, t) => `x${kind === 'data' ? 'D' : 'N'}${t.brp},${t.tseg1},${t.tseg2},${t.sjw}`;

  // 普通固件只有预设：S0..S9、Y2/Y5
  const PRESET_S = { 10000: 0, 20000: 1, 50000: 2, 100000: 3, 125000: 4, 250000: 5, 500000: 6, 750000: 7, 1000000: 8, 83333: 9 };
  const PRESET_Y = { 2000000: 2, 5000000: 5 };

  // 组一帧发送命令。f：{ id, ext, fd, brs, rtr, data: Uint8Array|number[] }
  function frameCmd(f) {
    const n = f.rtr ? (f.len || 0) : f.data.length;
    if (!f.fd && n > 8) throw new Error('普通 CAN 最多 8 个字节');
    if (f.fd && f.rtr) throw new Error('CAN FD 没有远程帧');
    const dlc = f.fd ? LEN_DLC(n) : n;
    if (dlc < 0) throw new Error('CAN FD 最多 64 个字节');
    const padded = f.fd ? FD_LEN[dlc] : n;
    if (f.ext ? f.id > 0x1FFFFFFF : f.id > 0x7FF) throw new Error('ID 超出范围');
    let c = f.fd ? (f.brs ? 'b' : 'd') : (f.rtr ? 'r' : 't');
    if (f.ext) c = c.toUpperCase();
    let s = c + f.id.toString(16).toUpperCase().padStart(f.ext ? 8 : 3, '0') + dlc.toString(16).toUpperCase();
    if (!f.rtr) for (let i = 0; i < padded; i++) s += (i < n ? f.data[i] : 0xCC).toString(16).toUpperCase().padStart(2, '0');
    return s;
  }

  // 解析一行接收数据（不含 \r）。tsMode：0 无时间戳，1 毫秒(4 位)，2 微秒(8 位)。
  // 返回 { kind:'frame', ... } / { kind:'info'|'status'|'version', ... } / null
  function parseLine(line, tsMode) {
    if (!line) return null;
    let s = line, tx = false;
    if (s[0] === '>') { tx = true; s = s.slice(1); }
    const c = s[0];
    if (!tx && c === 'x') {
      if (s[1] === 'I') {
        const p = s.slice(2).split(',');
        return { kind: 'info', name: p[0], version: p[1], clock: +p[2] };
      }
      if (s[1] === 'S') {
        const p = s.slice(2).split(',');
        return {
          kind: 'status', on: p[0] === '1', silent: p[1] === '1', psr: parseInt(p[2], 16), ecr: parseInt(p[3], 16),
          err: parseInt(p[4], 16), rxDropped: +p[5], ppm: +p[6], clockLocked: p[7] === '1', trim: +p[8],
        };
      }
      return null;
    }
    if (!'tTrRdDbB'.includes(c) || !c) return { kind: 'text', text: line };
    const ext = c === c.toUpperCase();
    const lc = c.toLowerCase();
    const fd = lc === 'd' || lc === 'b', brs = lc === 'b', rtr = lc === 'r';
    const idLen = ext ? 8 : 3;
    let p = 1;
    const id = parseInt(s.substr(p, idLen), 16); p += idLen;
    const dlc = parseInt(s[p], 16); p += 1;
    if (!(id >= 0) || !(dlc >= 0)) return null;
    const n = rtr ? 0 : (fd ? FD_LEN[dlc] : Math.min(dlc, 8));
    const data = new Uint8Array(n);
    for (let i = 0; i < n; i++, p += 2) {
      const v = parseInt(s.substr(p, 2), 16);
      if (!(v >= 0)) return null;
      data[i] = v;
    }
    let ts = null;
    if (tsMode === 1 && s.length >= p + 4) ts = parseInt(s.substr(p, 4), 16);
    else if (tsMode === 2 && s.length >= p + 8) ts = parseInt(s.substr(p, 8), 16);
    return { kind: 'frame', tx, id, ext, fd, brs, rtr, dlc, data, ts };
  }

  // 把设备的微秒计数（32 位，71 分钟一圈）展开成从 0 开始的秒数，
  // 并按设备报告的时钟误差（ppm）修正。
  class Clock {
    constructor() { this.reset(); }
    reset() { this.base = null; this.last = 0; this.wraps = 0; this.ppm = 0; }
    seconds(us) {
      if (this.base === null) { this.base = us; this.last = us; }
      if (us < this.last && this.last - us > 0x80000000) this.wraps++;
      this.last = us;
      const raw = (this.wraps * 4294967296 + us - this.base) / 1e6;
      return raw / (1 + this.ppm / 1e6);
    }
  }

  // 接收缓冲：按 \r 切行（\a 是命令失败）
  class LineReader {
    constructor(onLine) { this.buf = ''; this.onLine = onLine; }
    push(text) {
      this.buf += text;
      let i;
      while ((i = this.buf.search(/[\r\x07]/)) >= 0) {
        const line = this.buf.slice(0, i), end = this.buf[i];
        this.buf = this.buf.slice(i + 1);
        this.onLine(line, end === '\x07');
      }
      if (this.buf.length > 4096) this.buf = '';
    }
  }

  // 估算一帧在总线上的位数（不含填充位），用来算负载率
  function frameBits(f, nominal, data) {
    const n = f.data ? f.data.length : 0;
    if (!f.fd) return (f.ext ? 64 : 44) + 8 * n + 3;               // + 帧间隔
    const arbBits = (f.ext ? 32 : 13) + 6;                          // 仲裁 + 控制位到 BRS
    const dataBits = 8 * n + (n > 16 ? 26 : 22) + 4;                // ESI、DLC、数据、CRC
    const tail = 13;                                                // CRC 定界、ACK、EOF、间隔
    if (!f.brs || !data) return arbBits + dataBits + tail;
    return arbBits + tail + dataBits * nominal / data;              // 折算成仲裁段位时间
  }

  return { FD_LEN, LEN_DLC, timing, timingCmd, PRESET_S, PRESET_Y, frameCmd, parseLine, Clock, LineReader, frameBits };
})();
if (typeof module !== 'undefined') module.exports = Slcan;
