// 通用诊断引擎（阶段 2）：ISO-TP 实时收发（单帧 / 多帧 / 流控 / 0x78 等待）、
// UDS 服务组包与解析、故障码解析、控制器配置、安全访问算法插件。
// 纯逻辑部分（buildFrames / parseDtcResp / nrcText / runKeyPlugin）不依赖浏览器，可在 node 里自测。
// 保密内容（控制器 ID、安全算法、DID 定义）都由用户在设备上加载，不进仓库。
(() => {
  const FD_LEN = [8, 12, 16, 20, 24, 32, 48, 64];
  // 把实际长度向上取整到合法的 CAN FD 数据长度
  const fdLen = n => n <= 8 ? n : FD_LEN.find(x => x >= n) || 64;
  const hex2 = b => b.toString(16).toUpperCase().padStart(2, '0');

  // 故障码：3 字节 → 显示码（和离线分析、SEF 网站一致）
  const dtcText = (b1, b2, b3) =>
    'PCBU'[b1 >> 6] + ((b1 >> 4) & 3).toString(16) + (b1 & 15).toString(16).toUpperCase() + hex2(b2) + hex2(b3);
  const STATUS_BITS = ['当前故障', '本次循环故障', '待定', '已确认', '清码后未完成测试', '清码后曾失败', '本循环未完成测试', '请求报警灯'];
  const statusText = st => STATUS_BITS.filter((_, i) => st & (1 << i)).join('、') || '无';

  // 解析读故障码（19 02/0A/0F/13/15 等）的应答：59 <子功能> <状态可用掩码> 然后每 4 字节一条
  function parseDtcResp(p) {
    if (!p || p[0] !== 0x59) return null;
    const sub = p[1], list = [];
    let start = 3; // 跳过 59、子功能、状态可用掩码
    if (sub === 0x01 || sub === 0x07 || sub === 0x11 || sub === 0x12) return { sub, count: p.length >= 5 ? ((p[3] << 8) | p[4]) : 0, list };
    for (let i = start; i + 4 <= p.length; i += 4) {
      const st = p[i + 3];
      list.push({ code: dtcText(p[i], p[i + 1], p[i + 2]), bytes: hex2(p[i]) + hex2(p[i + 1]) + hex2(p[i + 2]), status: st, statusText: statusText(st) });
    }
    return { sub, mask: p[2], list };
  }

  const NRC = {
    0x10: '一般拒绝', 0x11: '服务不支持', 0x12: '子功能不支持', 0x13: '报文长度或格式错误', 0x14: '响应太长',
    0x21: '忙，请重发', 0x22: '条件不满足（车速/制动/电压/档位等）', 0x24: '请求顺序错误', 0x25: '子网节点无应答',
    0x26: '故障阻止执行', 0x31: '请求超出范围（DID/例程/参数不支持）', 0x33: '安全访问被拒绝（先做 27 解锁）',
    0x34: '需要认证', 0x35: '密钥无效', 0x36: '尝试次数超限（已锁定）', 0x37: '延时未到', 0x70: '不接受上传/下载',
    0x71: '数据传输暂停', 0x72: '一般编程失败', 0x73: '块序号错误', 0x78: '请求已收到，响应等待中',
    0x7E: '该会话不支持此子功能', 0x7F: '该会话不支持此服务', 0x92: '电压过高', 0x93: '电压过低',
  };
  // UDS 全局表（uds.js）在就用它的中文名，兼容离线分析
  const udsTable = () => { try { return typeof UDS !== 'undefined' ? UDS : null; } catch (e) { return null; } };
  function nrcText(code) {
    const u = udsTable();
    if (u && u.nrc && u.nrc[hex2(code)]) return u.nrc[hex2(code)][0];
    return NRC[code] || ('否定码 0x' + hex2(code));
  }
  function serviceName(sid) {
    const u = udsTable();
    if (u && u.services && u.services[hex2(sid)]) return u.services[hex2(sid)];
    return '服务 0x' + hex2(sid);
  }

  // 把一条 UDS 请求组成 ISO-TP 帧（纯函数）。返回 [Uint8Array,...]（每个是一帧的数据，已按需填充）。
  // cfg: { fd, pad }。payload: 数字数组 / Uint8Array（完整 UDS，含 SID）。
  function buildFrames(cfg, payload) {
    const p = Uint8Array.from(payload);
    const pad = cfg.pad === undefined || cfg.pad === null ? 0x00 : (cfg.pad & 0xFF);
    const frames = [];
    const sfMax = cfg.fd ? 62 : 7;            // 单帧最多能放的数据
    const put = (arr, min) => {               // 填充到合法长度
      const n = cfg.fd ? fdLen(Math.max(arr.length, min || 0)) : 8;
      const f = new Uint8Array(n).fill(pad);
      f.set(arr.subarray ? arr.subarray(0, n) : arr.slice(0, n));
      return f;
    };
    if (p.length <= sfMax) {
      if (!cfg.fd || p.length <= 7) frames.push(put(Uint8Array.of(p.length, ...p)));   // 经典单帧：首字节=长度
      else frames.push(put(Uint8Array.of(0x00, p.length, ...p)));                      // FD 单帧转义：00 长度
      return frames;
    }
    // 多帧：首帧 FF
    const ff = new Uint8Array((cfg.fd ? fdLen(0) : 8));
    ff.fill(pad);
    ff[0] = 0x10 | ((p.length >> 8) & 0x0F); ff[1] = p.length & 0xFF;
    const ffData = Math.min(p.length, ff.length - 2);
    ff.set(p.subarray(0, ffData), 2);
    frames.push(ff);
    // 连续帧 CF
    let off = ffData, sn = 1;
    const cfMax = ff.length - 1;
    while (off < p.length) {
      const chunk = p.subarray(off, off + cfMax);
      const cf = put(Uint8Array.of(0x20 | (sn & 0x0F), ...chunk), 1 + chunk.length);
      frames.push(cf);
      off += chunk.length; sn = (sn + 1) & 0x0F;
    }
    return frames;
  }

  // 运行用户加载的安全算法插件。code 是一段 JS，函数体，可用 seed(Uint8Array)、level(数字)、req(请求字节)，
  // 返回 key（数组 / Uint8Array / 十六进制字符串）。在用户自己的设备上运行，算法不进仓库。
  function runKeyPlugin(code, seed, level, req) {
    const fn = new Function('seed', 'level', 'req', 'bytes', code);
    const toBytes = x => {
      if (x == null) return null;
      if (typeof x === 'string') { const h = x.replace(/0x/gi, '').replace(/[^0-9a-f]/gi, ''); const a = new Uint8Array(h.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; }
      return Uint8Array.from(x);
    };
    return toBytes(fn(Uint8Array.from(seed), level, req ? Uint8Array.from(req) : null, toBytes));
  }

  // ---------------- 实时 ISO-TP ----------------
  // send(frame) 发一帧 { id, ext, fd, brs, data:Uint8Array }；log(msg,cls) 记日志（可选）。
  class IsoTp {
    constructor({ send, log } = {}) {
      this.send = send; this.log = log || (() => { });
      this.rx = null;   // 当前在收的响应事务
      this.tx = null;   // 当前在发的多帧事务（等 ECU 流控）
    }
    _frame(cfg, data) { return { id: cfg.req & 0x1FFFFFFF, ext: !!cfg.ext || (cfg.req > 0x7FF), fd: !!cfg.fd, brs: !!cfg.fd && cfg.brs !== false, data }; }

    // 发一条请求，等待并返回完整 UDS 响应。
    // 返回 { data:Uint8Array } | { nrc, nrcText, sid } | { timeout:true }
    request(cfg, payload, opt = {}) {
      const timeout = opt.timeout || 2000;
      const sid = payload[0];
      const frames = buildFrames(cfg, payload);
      return new Promise((resolve) => {
        let done = false;
        const finish = r => { if (done) return; done = true; clearTimeout(timer); this.rx = null; resolve(r); };
        let timer = setTimeout(() => finish({ timeout: true }), timeout);
        const bump = () => { clearTimeout(timer); timer = setTimeout(() => finish({ timeout: true }), timeout); };
        this.rx = {
          resp: cfg.resp & 0x1FFFFFFF, want: sid | 0x40, sid,
          buf: null, got: 0, sn: 0,
          onResp: p => {
            // 否定响应
            if (p[0] === 0x7F && p.length >= 3) {
              if (p[2] === 0x78) { this.log && this.log('ECU：请求已收到，正在处理…'); bump(); return; } // 等待，继续
              return finish({ nrc: p[2], nrcText: nrcText(p[2]), sid: p[1] });
            }
            finish({ data: p });
          },
          bump,
          sendFC: () => { try { this.send(this._frame({ ...cfg, req: cfg.req }, this._fc(cfg))); } catch (e) { /* ignore */ } },
        };
        // 发送请求帧（单帧直接发；多帧先发 FF，等 ECU 流控再发 CF）
        try {
          if (frames.length === 1) { this.send(this._frame(cfg, frames[0])); }
          else { this.tx = { cfg, frames, idx: 1, sid }; this.send(this._frame(cfg, frames[0])); }
        } catch (e) { return finish({ error: e.message }); }
      });
    }
    _fc(cfg) { // 流控：清除发送，BS=0，STmin=0
      const pad = cfg.pad == null ? 0 : cfg.pad & 0xFF;
      const n = cfg.fd ? 8 : 8; const f = new Uint8Array(n).fill(pad);
      f[0] = 0x30; f[1] = 0; f[2] = 0; return f;
    }

    // 喂入每一帧收到的报文（m: { id, ext, data:Uint8Array }）。
    onFrame(m) {
      const id = m.id & 0x1FFFFFFF, d = m.data;
      if (!d || !d.length) return;
      const type = d[0] >> 4;
      // 我们正在发多帧，等 ECU 的流控帧
      if (this.tx && id === (this.tx.cfg.resp & 0x1FFFFFFF) && type === 3) {
        const fs = d[0] & 0x0F;
        if (fs === 1) return;                 // WAIT：继续等
        if (fs === 2) { this.tx = null; return; } // 溢出：放弃
        // CTS：把剩下的连续帧发出去（BS=0 当作一次全发；STmin 简化为不等待）
        const t = this.tx; this.tx = null;
        for (let i = t.idx; i < t.frames.length; i++) { try { this.send(this._frame(t.cfg, t.frames[i])); } catch (e) { break; } }
        return;
      }
      if (!this.rx || id !== this.rx.resp) return;
      const r = this.rx;
      if (type === 0) {               // 单帧
        let n = d[0] & 0x0F, s = 1;
        if (n === 0 && d.length > 8) { n = d[1]; s = 2; }   // FD 转义单帧
        if (n && s + n <= d.length) { r.bump(); r.onResp(d.slice(s, s + n)); }
      } else if (type === 1) {        // 首帧
        let n = ((d[0] & 0x0F) << 8) | d[1], s = 2;
        if (n > 0 && n < 1 << 16) {
          r.buf = new Uint8Array(n); const k = Math.min(n, d.length - s);
          r.buf.set(d.subarray(s, s + k)); r.got = k; r.sn = 1;
          r.bump(); r.sendFC();        // 回流控，让 ECU 继续发
        }
      } else if (type === 2) {        // 连续帧
        if (!r.buf) return;
        if ((d[0] & 0x0F) !== (r.sn & 0x0F)) return;
        const k = Math.min(r.buf.length - r.got, d.length - 1);
        r.buf.set(d.subarray(1, 1 + k), r.got); r.got += k; r.sn = (r.sn + 1) & 0x0F; r.bump();
        if (r.got >= r.buf.length) { const p = r.buf; r.buf = null; r.onResp(p); }
      }
    }
    cancel() { this.rx = null; this.tx = null; }
  }

  const API = { FD_LEN, fdLen, dtcText, statusText, STATUS_BITS, parseDtcResp, nrcText, serviceName, buildFrames, runKeyPlugin, IsoTp };
  if (typeof module !== 'undefined') module.exports = API;
  if (typeof window !== 'undefined') window.Diag = API;
})();
