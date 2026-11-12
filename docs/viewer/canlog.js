// 报文读取与解析：BLF / ASC → 帧表；DBC 信号解码；ISO-TP 重组与 UDS 故障码识别。
// 纯函数，浏览器和 Node（自测）通用。
const CanLog = (() => {
  const EXT = 0x80000000;

  // ---- 帧表：按列存放，省内存 ----
  class Frames {
    constructor() {
      this.n = 0; this.cap = 0; this.dlen = 0;
      this.grow(1 << 14);
      this.data = new Uint8Array(1 << 20);
    }
    grow(cap) {
      const re = (A, old) => { const a = new A(cap); if (old) a.set(old.subarray(0, this.n)); return a; };
      this.t = re(Float64Array, this.t); this.id = re(Uint32Array, this.id); this.off = re(Uint32Array, this.off);
      this.len = re(Uint8Array, this.len); this.ch = re(Uint8Array, this.ch); this.fl = re(Uint8Array, this.fl);
      this.cap = cap;
    }
    // fl：1=发送 2=CAN FD 4=远程帧
    push(t, id, ch, fl, bytes) {
      if (this.n === this.cap) this.grow(this.cap * 2);
      if (this.dlen + bytes.length > this.data.length) {
        const d = new Uint8Array(this.data.length * 2); d.set(this.data.subarray(0, this.dlen)); this.data = d;
      }
      const i = this.n++;
      this.t[i] = t; this.id[i] = id; this.ch[i] = ch; this.fl[i] = fl;
      this.len[i] = bytes.length; this.off[i] = this.dlen;
      this.data.set(bytes, this.dlen); this.dlen += bytes.length;
    }
    bytes(i) { return this.data.subarray(this.off[i], this.off[i] + this.len[i]); }
    // 结束读取：时间从 0 开始、按时间排序（多通道 BLF 偶有乱序）、建 ID 索引
    finish() {
      const n = this.n;
      for (const k of ['t', 'id', 'off', 'len', 'ch', 'fl']) this[k] = this[k].slice(0, n);
      this.data = this.data.slice(0, this.dlen);
      let sorted = true;
      for (let i = 1; i < n; i++) if (this.t[i] < this.t[i - 1]) { sorted = false; break; }
      if (!sorted) {
        const ord = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => this.t[a] - this.t[b]);
        for (const k of ['t', 'id', 'off', 'len', 'ch', 'fl']) {
          const src = this[k], a = new src.constructor(n);
          for (let i = 0; i < n; i++) a[i] = src[ord[i]];
          this[k] = a;
        }
      }
      this.t0 = n ? this.t[0] : 0;
      for (let i = 0; i < n; i++) this.t[i] -= this.t0;
      this.dur = n ? this.t[n - 1] : 0;
      const cnt = new Map();
      for (let i = 0; i < n; i++) cnt.set(this.id[i], (cnt.get(this.id[i]) || 0) + 1);
      this.byId = new Map();
      for (const [id, c] of cnt) this.byId.set(id, new Uint32Array(c));
      const pos = new Map();
      for (let i = 0; i < n; i++) {
        const id = this.id[i], p = pos.get(id) || 0;
        this.byId.get(id)[p] = i; pos.set(id, p + 1);
      }
      return this;
    }
  }

  // ---- BLF（Vector 二进制日志）----
  const td = new TextDecoder('latin1');
  const sig4 = (u8, p) => td.decode(u8.subarray(p, p + 4));

  async function inflate(u8) {
    const ds = new DecompressionStream('deflate');    // BLF 用 zlib 封装，对应 'deflate'
    const out = new Response(new Blob([u8]).stream().pipeThrough(ds));
    return new Uint8Array(await out.arrayBuffer());
  }

  function findLOBJ(u8, p) {
    for (const end = u8.length - 3; p < end; p++)
      if (u8[p] === 0x4C && u8[p + 1] === 0x4F && u8[p + 2] === 0x42 && u8[p + 3] === 0x4A) return p;
    return -1;
  }

  // 解析一段（解压后的）对象流；返回未完整的尾部起点
  function blfObjects(u8, fr) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let p = 0;
    for (;;) {
      p = findLOBJ(u8, p);
      if (p < 0 || p + 16 > u8.length) return p < 0 ? Math.max(0, u8.length - 3) : p;
      const hsize = dv.getUint16(p + 4, true);
      const osize = dv.getUint32(p + 8, true), type = dv.getUint32(p + 12, true);
      if (osize < 16) { p += 4; continue; }
      if (p + osize > u8.length) return p;
      const flags = dv.getUint32(p + 16, true);
      const ts = Number(dv.getBigUint64(p + 24, true));       // V1 / V2 对象头的时间戳都在偏移 24
      const t = ts * (flags === 1 ? 1e-5 : 1e-9);
      const b = p + hsize;
      if (type === 1 || type === 86) {                          // CAN_MESSAGE / CAN_MESSAGE2
        const ch = dv.getUint16(b, true), f = u8[b + 2], dlc = u8[b + 3], id = dv.getUint32(b + 4, true);
        const n = Math.min(dlc, 8);
        fr.push(t, id, ch, (f & 1) | (f & 0x80 ? 4 : 0), f & 0x80 ? new Uint8Array(0) : u8.subarray(b + 8, b + 8 + n));
      } else if (type === 100) {                                // CAN_FD_MESSAGE
        const ch = dv.getUint16(b, true), f = u8[b + 2], id = dv.getUint32(b + 4, true);
        const fdf = u8[b + 13], n = Math.min(u8[b + 14], 64);
        fr.push(t, id, ch, (f & 1) | (fdf & 1 ? 2 : 0) | (f & 0x80 ? 4 : 0), u8.subarray(b + 20, b + 20 + n));
      } else if (type === 101) {                                // CAN_FD_MESSAGE_64
        const ch = u8[b], n = Math.min(u8[b + 2], 64), id = dv.getUint32(b + 4, true);
        const f = dv.getUint32(b + 12, true), dir = u8[b + 34];
        fr.push(t, id, ch, (dir === 1 ? 1 : 0) | (f & 0x1000 ? 2 : 0) | (f & 0x10 ? 4 : 0), u8.subarray(b + 40, b + 40 + n));
      }
      p += osize;
    }
  }

  async function readBLF(buf, progress) {
    const u8 = new Uint8Array(buf), dv = new DataView(buf);
    if (sig4(u8, 0) !== 'LOGG') throw new Error('不是有效的 BLF 文件');
    const fr = new Frames();
    let p = dv.getUint32(4, true), tail = new Uint8Array(0), k = 0;
    while (p + 16 <= u8.length) {
      if (sig4(u8, p) !== 'LOBJ') { const q = findLOBJ(u8, p + 1); if (q < 0) break; p = q; continue; }
      const osize = dv.getUint32(p + 8, true), type = dv.getUint32(p + 12, true);
      if (osize < 16 || p + osize > u8.length) break;
      if (type === 10) {                                        // LOG_CONTAINER
        const method = dv.getUint16(p + 16, true);
        let body = u8.subarray(p + 32, p + osize);
        if (method === 2) body = await inflate(body);
        else if (method !== 0) body = null;
        if (body) {
          const all = new Uint8Array(tail.length + body.length);
          all.set(tail); all.set(body, tail.length);
          tail = all.slice(blfObjects(all, fr));
        }
      } else {                                                  // 未打包的对象
        blfObjects(u8.subarray(p, p + osize), fr);
      }
      p += osize + (osize % 4);
      if (progress && (++k & 31) === 0) { progress(p / u8.length); await new Promise(r => setTimeout(r)); }
    }
    return fr.finish();
  }

  // ---- ASC（Vector 文本日志）----
  const FD_LEN = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];
  async function readASC(text, progress) {
    const fr = new Frames();
    let hex = true, rel = false, last = 0;
    const lines = text.split(/\r?\n/);
    const b = new Uint8Array(64);
    for (let li = 0; li < lines.length; li++) {
      const s = lines[li].trim();
      if (!s) continue;
      if (/^base\s/i.test(s)) { hex = /^base\s+hex/i.test(s); rel = /timestamps\s+relative/i.test(s); continue; }
      if (!/^\d/.test(s)) continue;
      const tk = s.split(/\s+/);
      let t = parseFloat(tk[0]);
      if (!isFinite(t)) continue;
      if (rel) { t += last; last = t; }
      const pid = v => {
        const ext = /x$/i.test(v), id = parseInt(ext ? v.slice(0, -1) : v, hex ? 16 : 10);
        return isNaN(id) ? -1 : (ext ? (id | EXT) >>> 0 : id);
      };
      if (/^CANFD$/i.test(tk[1])) {
        // t CANFD ch Rx|Tx id [报文名] brs esi dlc 长度 数据...
        // 也兼容某些记录仪的非标准写法：t CANFD ch id Rx|Tx brs esi d dlc(十进制) 长度 数据...
        const swap = /^(rx|tx)$/i.test(tk[4]) && !/^(rx|tx)$/i.test(tk[3]);
        const ch = +tk[2], dir = tk[swap ? 4 : 3], id = pid(tk[swap ? 3 : 4]);
        let k = 5;
        if (!/^[01]$/.test(tk[k])) k++;
        if (swap && /^d$/i.test(tk[k + 2]) && FD_LEN[+tk[k + 3]] === +tk[k + 4]) k++;
        const n = parseInt(tk[k + 3], 10);
        if (id < 0 || !(n >= 0) || n > 64) continue;
        for (let i = 0; i < n; i++) b[i] = parseInt(tk[k + 4 + i], 16);
        fr.push(t, id, ch, (/^tx/i.test(dir) ? 1 : 0) | 2, b.subarray(0, n));
      } else if (/^\d+$/.test(tk[1]) && /^(rx|tx)$/i.test(tk[3])) {
        // t ch id Rx|Tx d|r dlc 数据...
        const ch = +tk[1], id = pid(tk[2]);
        if (id < 0) continue;
        if (/^r$/i.test(tk[4])) { fr.push(t, id, ch, (/^tx/i.test(tk[3]) ? 1 : 0) | 4, b.subarray(0, 0)); continue; }
        if (!/^d$/i.test(tk[4])) continue;
        const n = Math.min(parseInt(tk[5], 16), 8);
        for (let i = 0; i < n; i++) b[i] = parseInt(tk[6 + i], 16);
        fr.push(t, id, ch, /^tx/i.test(tk[3]) ? 1 : 0, b.subarray(0, n));
      }
      if (progress && (li & 0xFFFF) === 0) { progress(li / lines.length); await new Promise(r => setTimeout(r)); }
    }
    return fr.finish();
  }

  async function read(name, buf, progress) {
    if (/\.blf$/i.test(name)) return readBLF(buf, progress);
    if (/\.asc$/i.test(name)) return readASC(new TextDecoder('latin1').decode(buf), progress);
    throw new Error('只支持 .blf 和 .asc 文件');
  }

  // ---- DBC 信号解码 ----
  function rawValue(d, s) {
    let v = 0;
    if (s.bo === 1) {                                           // Intel：起始位为最低位
      for (let i = s.bl - 1; i >= 0; i--) {
        const p = s.sb + i, by = p >> 3;
        if (by >= d.length) return null;
        v = v * 2 + ((d[by] >> (p & 7)) & 1);
      }
    } else {                                                    // Motorola：起始位为最高位，锯齿编号
      let p = s.sb;
      for (let i = 0; i < s.bl; i++) {
        const by = p >> 3;
        if (by >= d.length) return null;
        v = v * 2 + ((d[by] >> (p & 7)) & 1);
        p = (p & 7) === 0 ? p + 15 : p - 1;
      }
    }
    if (s.fl) {
      const dv = new DataView(new ArrayBuffer(8));
      if (s.fl === 1) { dv.setUint32(0, v); return dv.getFloat32(0); }
      dv.setUint32(0, Math.floor(v / 2 ** 32)); dv.setUint32(4, v % 2 ** 32); return dv.getFloat64(0);
    }
    if (s.s && v >= 2 ** (s.bl - 1)) v -= 2 ** s.bl;
    return v;
  }

  // 解码某报文的一个信号 → {t: Float64Array, raw: Float64Array, v: Float64Array}
  function decodeSignal(fr, msg, s) {
    const idx = fr.byId.get(msg.ext ? (msg.id | EXT) >>> 0 : msg.id);
    if (!idx) return { t: new Float64Array(0), raw: new Float64Array(0), v: new Float64Array(0) };
    const mux = typeof s.mux === 'number' ? msg.sigs.find(x => x.mux === 'M') : null;
    const t = new Float64Array(idx.length), raw = new Float64Array(idx.length), v = new Float64Array(idx.length);
    let n = 0;
    for (const i of idx) {
      if (fr.fl[i] & 4) continue;
      const d = fr.bytes(i);
      if (mux && rawValue(d, mux) !== s.mux) continue;
      const r = rawValue(d, s);
      if (r === null) continue;
      t[n] = fr.t[i]; raw[n] = r; v[n] = r * s.f + s.o; n++;
    }
    return { t: t.subarray(0, n), raw: raw.subarray(0, n), v: v.subarray(0, n) };
  }

  // ---- 故障码 ----
  const hex2 = x => x.toString(16).toUpperCase().padStart(2, '0');
  // 3 字节 → 显示码（如 0x40 0x35 0x12 → C003512）
  function dtcText(b1, b2, b3) {
    return 'PCBU'[b1 >> 6] + ((b1 >> 4) & 3).toString(16) + (b1 & 15).toString(16).toUpperCase() + hex2(b2) + hex2(b3);
  }
  const STATUS_BITS = ['当前故障', '本次循环故障', '待定', '已确认', '清码后未完成测试', '清码后曾失败', '本循环未完成测试', '请求报警灯'];
  const statusText = st => STATUS_BITS.filter((_, i) => st & (1 << i)).join('、') || '无';
  const isDiagId = id => (!(id & EXT) && id >= 0x700 && id <= 0x7FF) || ((id & EXT) && ((id & 0x1FFF0000) >>> 16) === 0x18DA);

  // ISO-TP 重组 → [{t, id, ch, p: Uint8Array, fi: [组成它的帧序号]}]
  function isotp(fr) {
    const out = [], st = new Map();
    for (const [id, idx] of fr.byId) {
      if (!isDiagId(id)) continue;
      for (const i of idx) {
        const d = fr.bytes(i), key = id + ':' + fr.ch[i];
        if (!d.length) continue;
        const type = d[0] >> 4;
        if (type === 0) {
          let n = d[0] & 15, s = 1;
          if (n === 0 && d.length > 8) { n = d[1]; s = 2; }
          if (n && s + n <= d.length) out.push({ t: fr.t[i], id, ch: fr.ch[i], p: d.slice(s, s + n), fi: [i] });
          st.delete(key);
        } else if (type === 1) {
          let n = ((d[0] & 15) << 8) | d[1], s = 2;
          if (n === 0) { n = ((d[2] << 24) | (d[3] << 16) | (d[4] << 8) | d[5]) >>> 0; s = 6; }
          if (n > 0 && n < 1 << 20) {
            const buf = new Uint8Array(n), k = Math.min(n, d.length - s);
            buf.set(d.subarray(s, s + k));
            st.set(key, { t: fr.t[i], buf, got: k, sn: 1, fi: [i] });
          }
        } else if (type === 2) {
          const x = st.get(key);
          if (!x) continue;
          if ((d[0] & 15) !== (x.sn & 15)) { st.delete(key); continue; }
          const k = Math.min(x.buf.length - x.got, d.length - 1);
          x.buf.set(d.subarray(1, 1 + k), x.got); x.got += k; x.sn++; x.fi.push(i);
          if (x.got >= x.buf.length) { out.push({ t: x.t, id, ch: fr.ch[i], p: x.buf, fi: x.fi }); st.delete(key); }
        }
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }

  // 找故障码：诊断应答（19 服务）+ DBC 中广播的 DTC 字节信号
  // 返回 {dtcs: [{code, b, st, src, ecu, t, n}], events: [{t, ecu, text}]}
  function findDTCs(fr, db) {
    const byKey = new Map(), events = [];
    const ecuOf = id => {
      const m = db && db.msgs.find(m => ((m.ext ? (m.id | EXT) >>> 0 : m.id)) === id);
      return m ? m.tx : '0x' + (id & 0x1FFFFFFF).toString(16).toUpperCase();
    };
    const add = (b1, b2, b3, st, src, ecu, t) => {
      if (!(b1 | b2 | b3)) return;
      const code = dtcText(b1, b2, b3), k = ecu + code;
      const x = byKey.get(k);
      if (x) { x.st |= st; x.n++; x.tl = t; } else byKey.set(k, { code, b: hex2(b1) + hex2(b2) + ' ' + hex2(b3), st, src, ecu, t, tl: t, n: 1 });
    };
    for (const m of isotp(fr)) {
      const p = m.p, ecu = ecuOf(m.id);
      if (p[0] === 0x59 && [0x02, 0x0A, 0x0F, 0x13, 0x15].includes(p[1])) {
        for (let i = 3; i + 4 <= p.length; i += 4)
          if (p[1] !== 0x0A || (p[i + 3] & 0x0D)) add(p[i], p[i + 1], p[i + 2], p[i + 3], '诊断应答 19 ' + hex2(p[1]), ecu, m.t);
        events.push({ t: m.t, ecu, text: `读故障码应答（19 ${hex2(p[1])}），${Math.max(0, (p.length - 3) >> 2)} 条` });
      } else if (p[0] === 0x59 && [0x04, 0x06].includes(p[1]) && p.length >= 6) {
        add(p[2], p[3], p[4], p[5], '诊断应答 19 ' + hex2(p[1]), ecu, m.t);
      } else if (p[0] === 0x54) {
        events.push({ t: m.t, ecu, text: '清除故障码成功（14 服务）' });
      } else if (p[0] === 0x7F && p[1] === 0x19) {
        events.push({ t: m.t, ecu, text: '读故障码被拒绝，否定码 0x' + hex2(p[2]) });
      }
    }
    // 广播信号：XXX_DTC1_HighByte / MiddByte / LowByte / Status
    if (db) for (const msg of db.msgs) {
      const groups = {};
      for (const s of msg.sigs) {
        const m = s.n.match(/^(.*?)_?(High|Midd|Middle|Mid|Low)_?Byte$/i) || s.n.match(/^(.*DTC\d*)_?(Status|Sts)$/i);
        if (m) (groups[m[1]] = groups[m[1]] || {})[m[2].toLowerCase()[0] === 'm' ? 'm' : m[2].toLowerCase()[0]] = s;
      }
      for (const [g, x] of Object.entries(groups)) {
        if (!x.h || !x.m || !x.l) continue;
        const idx = fr.byId.get(msg.ext ? (msg.id | EXT) >>> 0 : msg.id);
        if (!idx) continue;
        for (const i of idx) {
          const d = fr.bytes(i), h = rawValue(d, x.h), md = rawValue(d, x.m), l = rawValue(d, x.l);
          if (h === null || md === null || l === null) continue;
          add(h, md, l, x.s ? rawValue(d, x.s) || 0 : 0, '广播信号 ' + g, msg.tx, fr.t[i]);
        }
      }
    }
    return { dtcs: [...byKey.values()].sort((a, b) => a.t - b.t), events };
  }

  // 疑似异常的状态信号：故障/报警类、带值描述、出现了非“正常”的取值
  const CAND = /fail|fault|flt|err|warn|lamp|light|malfunc|invalid|defect|abnormal|故障|失效|错误|报警|异常|指示灯/i;
  const BADV = /fail|fault|err|warn|malfunc|invalid|defect|abnormal|故障|失效|错误|报警|异常/i;
  const ONV = /^on$|\bon\b|active|request|blink|flash|点亮|亮|闪/i;
  const OKV = /\bno\b|\bnot\b|normal|^no|none|无|正常|未|inactive|\boff\b|\bok\b|^valid|reserved|init/i;
  function abnormal(s, txt) {
    if (OKV.test(txt)) return false;
    return BADV.test(txt) || (/lamp|light|warn|indicat|报警|灯/i.test(s.n) && ONV.test(txt));
  }
  function suspects(fr, db) {
    const out = [];
    if (!db) return out;
    for (const msg of db.msgs) {
      if (!fr.byId.has(msg.ext ? (msg.id | EXT) >>> 0 : msg.id)) continue;
      for (const s of msg.sigs) {
        if (!s.vt || !CAND.test(s.n + ' ' + (s.c || ''))) continue;
        const d = decodeSignal(fr, msg, s), seen = new Map();
        for (let i = 0; i < d.raw.length; i++) if (!seen.has(d.raw[i])) seen.set(d.raw[i], d.t[i]);
        for (const [r, t] of seen) {
          const txt = s.vt[r];
          if (txt !== undefined && abnormal(s, txt)) out.push({ msg: msg.name, sig: s.n, raw: r, text: txt, t });
        }
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }

  // ---- 通用诊断知识：单帧解释 ----
  const H = b => hex2(b);
  const hexs = (u8, a = 0, b = u8.length) => Array.from(u8.subarray(a, b), H).join(' ');
  function tpFrame(d) {
    if (!d.length) return '';
    const t = d[0] >> 4;
    if (t === 0) { const n = (d[0] & 15) || (d.length > 8 ? d[1] : 0); return `单帧（SF），有效数据 ${n} 字节`; }
    if (t === 1) { const n = ((d[0] & 15) << 8) | d[1]; return `首帧（FF），整条报文共 ${n || ((d[2] << 24) | (d[3] << 16) | (d[4] << 8) | d[5]) >>> 0} 字节，后面还有连续帧`; }
    if (t === 2) return `连续帧（CF），序号 ${d[0] & 15}`;
    if (t === 3) {
      const fs = ['继续发送（CTS）', '等待（Wait）', '溢出（Overflow），接收方缓存不足'][d[0] & 15] || '未知';
      const st = d[2] <= 0x7F ? d[2] + ' ms' : (d[2] >= 0xF1 && d[2] <= 0xF9 ? (d[2] - 0xF0) * 100 + ' µs' : '保留值');
      return `流控帧（FC）：${fs}，块大小 ${d[1] || '不限'}，最小间隔 ${st}`;
    }
    return '不是 ISO-TP 诊断帧格式';
  }

  // 解释一条完整的 UDS 报文（已重组）；U 为 tools/uds.json。返回若干行文字
  function udsExplain(p, U) {
    if (!p || !p.length || !U) return [];
    const k = H(p[0]), out = [], name = x => U.services[x] || '未知服务';
    const sub = (tbl, b) => (tbl[H(b & 0x7F)] || '子功能 0x' + H(b & 0x7F)) + (b & 0x80 ? '（抑制正响应）' : '');
    const did = (a, b) => { const x = H(a) + H(b); return `0x${x}${U.dids[x] ? ' ' + U.dids[x] : ''}`; };
    const ascii = u8 => { const s = String.fromCharCode(...u8); return /^[\x20-\x7E]+$/.test(s.replace(/\x00+$/, '')) ? s.replace(/\x00+$/, '') : ''; };
    if (p[0] === 0x7F) {
      const n = U.nrc[H(p[2])] || ['未定义的否定码', ''];
      out.push(`❌ 否定响应：服务 0x${H(p[1])} ${name(H(p[1]))} 被拒绝`);
      out.push(`否定码 NRC 0x${H(p[2])}：${n[0]}`);
      if (n[1]) out.push('说明：' + n[1]);
      return out;
    }
    let req = true, sid = k;
    if (!U.services[k] && U.services[H(p[0] - 0x40)]) { req = false; sid = H(p[0] - 0x40); }
    if (!U.services[sid]) return [`首字节 0x${k} 不是常见的 UDS 服务`];
    out.push((req ? '➡️ 请求：' : '✅ 正响应：') + `0x${sid} ${name(sid)}`);
    const b1 = p[1];
    switch (sid) {
      case '10':
        if (p.length > 1) out.push('会话：' + sub(U.sessions, b1));
        if (!req && p.length >= 6) out.push(`P2 = ${(p[2] << 8 | p[3])} ms，P2* = ${(p[4] << 8 | p[5]) * 10} ms`);
        break;
      case '11': if (p.length > 1) out.push('复位类型：' + sub(U.resets, b1)); break;
      case '14': if (req && p.length >= 4) out.push('故障码组：' + (p[1] === 0xFF && p[2] === 0xFF && p[3] === 0xFF ? 'FFFFFF 全部故障码' : hexs(p, 1, 4))); break;
      case '19': {
        if (p.length > 1) out.push('子功能：' + sub(U.dtcSub, b1));
        if (req && [0x02, 0x0A, 0x0F, 0x13, 0x15, 0x17].includes(b1 & 0x7F) && p.length > 2) out.push(`状态掩码 0x${H(p[p.length - 1])}：${statusText(p[p.length - 1])}`);
        if (req && [0x04, 0x06].includes(b1) && p.length >= 6) out.push(`故障码 ${dtcText(p[2], p[3], p[4])}，记录号 0x${H(p[5])}`);
        if (!req && [0x02, 0x0A, 0x0F, 0x13, 0x15].includes(b1)) {
          out.push(`ECU 支持的状态位 0x${H(p[2])}，共 ${Math.max(0, (p.length - 3) >> 2)} 个故障码：`);
          for (let i = 3; i + 4 <= p.length; i += 4) out.push(`  ${dtcText(p[i], p[i + 1], p[i + 2])}（${hexs(p, i, i + 3)}）状态 0x${H(p[i + 3])}：${statusText(p[i + 3])}`);
        }
        if (!req && b1 === 0x01 && p.length >= 6) out.push(`符合条件的故障码数量：${p[4] << 8 | p[5]}`);
        if (!req && [0x04, 0x06].includes(b1) && p.length >= 6) out.push(`故障码 ${dtcText(p[2], p[3], p[4])} 状态 0x${H(p[5])}：${statusText(p[5])}；后续为快照 / 扩展数据：${hexs(p, 6)}`);
        break;
      }
      case '22':
        if (req) for (let i = 1; i + 2 <= p.length; i += 2) out.push('读取 ' + did(p[i], p[i + 1]));
        else if (p.length >= 3) {
          out.push('数据标识符 ' + did(p[1], p[2]));
          const data = p.subarray(3), a = ascii(data);
          out.push('数据：' + hexs(data) + (a ? `（ASCII：${a}）` : ''));
          if (H(p[1]) + H(p[2]) === 'F186' && data.length) out.push('当前会话：' + (U.sessions[H(data[0])] || '0x' + H(data[0])));
        }
        break;
      case '2E':
        if (p.length >= 3) out.push('数据标识符 ' + did(p[1], p[2]));
        if (req && p.length > 3) { const a = ascii(p.subarray(3)); out.push('写入：' + hexs(p, 3) + (a ? `（ASCII：${a}）` : '')); }
        break;
      case '27':
        if (p.length > 1) out.push(`安全等级 ${(b1 + 1) >> 1}：` + (b1 & 1 ? (req ? '请求种子（Seed）' : '返回种子 ' + hexs(p, 2) + (p.subarray(2).every(x => !x) ? '（全 0 表示已解锁）' : '')) : (req ? '发送密钥（Key）' + hexs(p, 2) : '密钥正确，已解锁')));
        break;
      case '28':
        if (p.length > 1) out.push('控制方式：' + sub(U.commCtrl, b1));
        if (req && p.length > 2) out.push('报文类型：' + (U.commType[H(p[2] & 3)] || '0x' + H(p[2])));
        break;
      case '2F':
        if (p.length >= 3) out.push('数据标识符 ' + did(p[1], p[2]));
        if (p.length > 3) out.push('控制参数：' + (U.ioCtrl[H(p[3])] || '0x' + H(p[3])) + (p.length > 4 ? '，数据 ' + hexs(p, 4) : ''));
        break;
      case '31':
        if (p.length > 1) out.push(sub(U.routineSub, b1));
        if (p.length >= 4) out.push(`例程 ID 0x${H(p[2])}${H(p[3])}` + (p.length > 4 ? `，${req ? '参数' : '结果'} ${hexs(p, 4)}` : ''));
        break;
      case '3E': out.push(b1 & 0x80 ? '保持会话（不需要应答）' : '保持会话'); break;
      case '85': if (p.length > 1) out.push(sub(U.dtcSetting, b1)); break;
      case '34': case '35': if (!req && p.length > 2) out.push('ECU 每块最多接收 ' + parseInt(hexs(p, 2).replace(/ /g, '') || '0', 16) + ' 字节'); break;
      case '36': if (p.length > 1) out.push(`块序号 ${b1}` + (req ? `，数据 ${p.length - 2} 字节` : '')); break;
    }
    return out;
  }

  return { Frames, read, readBLF, readASC, rawValue, decodeSignal, isotp, findDTCs, suspects, dtcText, statusText, tpFrame, udsExplain, isDiagId, EXT };
})();
if (typeof module !== 'undefined') module.exports = CanLog;
