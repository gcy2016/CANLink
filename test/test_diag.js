// 诊断引擎自测：组帧、故障码解析、否定码、安全算法插件，以及实时 ISO-TP 与模拟 ECU 的单帧 / 多帧 / 流控 / 0x78 往返。
const assert = require('assert');
const Diag = require('../docs/diag.js');
let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('✓', m); pass++; };
const hex = a => Array.from(a, b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

// ---- 组帧 ----
{
  const f = Diag.buildFrames({ fd: false, pad: 0 }, [0x22, 0xFD, 0x54]);
  ok(f.length === 1 && hex(f[0]) === '03 22 FD 54 00 00 00 00', '经典单帧：首字节=长度，填充 0');
  const f2 = Diag.buildFrames({ fd: false, pad: 0xAA }, [0x19, 0x02, 0xFF]);
  ok(hex(f2[0]) === '03 19 02 FF AA AA AA AA', '填充字节可设（0xAA）');
}
{
  // 多帧：18 字节请求 → FF + 2×CF
  const payload = Array.from({ length: 18 }, (_, i) => i + 1);
  const f = Diag.buildFrames({ fd: false, pad: 0 }, payload);
  ok(f.length === 3, '18 字节 → 首帧 + 2 连续帧');
  ok(f[0][0] === 0x10 && f[0][1] === 18, '首帧 10 12（长度 18）');
  ok(f[1][0] === 0x21 && f[2][0] === 0x22, '连续帧序号 21、22');
  // 重组回来核对
  const back = [...f[0].slice(2), ...f[1].slice(1), ...f[2].slice(1)].slice(0, 18);
  ok(hex(Uint8Array.from(back)) === hex(Uint8Array.from(payload)), '多帧重组和原数据一致');
}
{
  const f = Diag.buildFrames({ fd: true, pad: 0 }, Array.from({ length: 20 }, (_, i) => i));
  ok(f.length === 1 && f[0][0] === 0 && f[0][1] === 20 && f[0].length === 24, 'FD 长单帧：00 长度，长度补到合法 DLC（24）');
}

// ---- 故障码解析 ----
{
  const r = Diag.parseDtcResp(Uint8Array.of(0x59, 0x02, 0xFF, 0x50, 0x1F, 0x00, 0x09, 0xC1, 0x23, 0x45, 0x08));
  ok(r.list.length === 2, '读到 2 条故障码');
  ok(r.list[0].code === 'C101F00' && (r.list[0].status & 0x01) && (r.list[0].status & 0x08), '第一条解码 + 状态位（当前/已确认）');
  ok(Diag.statusText(0x09) === '当前故障、已确认', '状态位中文');
}

// ---- 否定码 ----
ok(Diag.nrcText(0x33).includes('安全'), 'NRC 0x33 → 安全访问被拒绝');
ok(Diag.nrcText(0x78).includes('等待'), 'NRC 0x78 → 响应等待中');

// ---- 安全算法插件（用户加载，这里用示例算法测运行机制）----
{
  const code = `const s=(seed[0]<<24|seed[1]<<16|seed[2]<<8|seed[3])>>>0; const k=(s^0x12345678)>>>0; return [k>>>24,k>>16&255,k>>8&255,k&255];`;
  const key = Diag.runKeyPlugin(code, [0x11, 0x22, 0x33, 0x44], 1, null);
  ok(hex(key) === '03 16 65 3C', '插件返回数组');
  const key2 = Diag.runKeyPlugin(`return 'DEADBEEF'`, [0, 0, 0, 0], 1);
  ok(hex(key2) === 'DE AD BE EF', '插件返回十六进制字符串');
}

// ---- 实时 ISO-TP：接一个模拟 ECU ----
// 模拟 ECU：收我方请求帧（单/多帧 + 我方流控），按服务组织响应（单帧或多帧，带一次 0x78）
function makeEcu(reqId, respId, { pending } = {}) {
  let tp = null;      // 正在收的请求
  let pendingOnce = pending;
  const ecu = { onTx: null };  // onTx(frame) 把 ECU 发出的帧交回给 IsoTp
  const sendResp = payload => {
    const frames = Diag.buildFrames({ fd: false, pad: 0 }, payload);
    // 若是多帧，等对方流控；简化：先发 FF，再在收到 FC 后发 CF
    ecu._pending = { frames, idx: 1 };
    ecu.onTx({ id: respId, ext: respId > 0x7FF, data: frames[0] });
    if (frames.length === 1) ecu._pending = null;
  };
  ecu.feed = m => {   // 收到我方发来的帧（请求帧，或我方对 ECU 多帧响应回的流控帧，都在 reqId 上）
    if ((m.id & 0x1FFFFFFF) !== reqId) return;
    const d = m.data, type = d[0] >> 4;
    if (type === 3) {   // 我方流控：把 ECU 剩下的连续帧发出去
      if (ecu._pending) { const p = ecu._pending; ecu._pending = null; for (let i = p.idx; i < p.frames.length; i++) ecu.onTx({ id: respId, data: p.frames[i] }); }
      return;
    }
    let req;
    if (type === 0) { const n = d[0] & 0x0F; req = d.slice(1, 1 + n); }
    else if (type === 1) { const n = ((d[0] & 0x0F) << 8) | d[1]; tp = { buf: [...d.slice(2)], n }; ecu.onTx({ id: respId, data: Uint8Array.of(0x30, 0, 0) }); return; }
    else if (type === 2) { if (!tp) return; tp.buf.push(...d.slice(1)); if (tp.buf.length >= tp.n) { req = Uint8Array.from(tp.buf.slice(0, tp.n)); tp = null; } else return; }
    if (!req) return;
    const sid = req[0];
    if (pendingOnce) { pendingOnce = false; ecu.onTx({ id: respId, data: Uint8Array.of(0x03, 0x7F, sid, 0x78) }); setTimeout(() => respond(sid, req), 30); return; }
    respond(sid, req);
  };
  function respond(sid, req) {
    if (sid === 0x19) {   // 读故障码 → 多帧：59 02 FF + 3 条
      sendResp([0x59, 0x02, 0xFF, 0x50, 0x1F, 0x00, 0x09, 0xC1, 0x23, 0x45, 0x08, 0xE1, 0x5F, 0x00, 0x01]);
    } else if (sid === 0x22) {  // 读 DID → 单帧回显
      sendResp([0x62, req[1], req[2], 0x12, 0x34]);
    } else if (sid === 0x27 && req[1] === 1) {  // 请求种子
      sendResp([0x67, 0x01, 0x11, 0x22, 0x33, 0x44]);
    } else if (sid === 0x27 && req[1] === 2) {  // 发密钥 → 成功
      sendResp([0x67, 0x02]);
    } else if (sid === 0x2E) {  // 写 DID（我方多帧）→ 单帧确认
      sendResp([0x6E, req[1], req[2]]);
    } else { sendResp([0x7F, sid, 0x11]); }
  }
  return ecu;
}

function wire(reqId, respId, opt) {
  const ecu = makeEcu(reqId, respId, opt);
  const tp = new Diag.IsoTp({ send: f => ecu.feed(f), log: () => { } });
  ecu.onTx = f => tp.onFrame(f);
  return { tp, cfg: { req: reqId, resp: respId, fd: false, pad: 0 } };
}

(async () => {
  {
    const { tp, cfg } = wire(0x7E0, 0x7E8);
    const r = await tp.request(cfg, [0x22, 0xFD, 0x54], { timeout: 1000 });
    ok(r.data && r.data[0] === 0x62 && r.data[3] === 0x12, '读 DID：单帧响应往返');
  }
  {
    const { tp, cfg } = wire(0x7E0, 0x7E8);
    const r = await tp.request(cfg, [0x19, 0x02, 0xFF], { timeout: 1000 });
    const d = Diag.parseDtcResp(r.data);
    ok(r.data && d.list.length === 3, '读故障码：多帧响应 + 我方回流控，重组出 3 条');
  }
  {
    const { tp, cfg } = wire(0x7E0, 0x7E8, { pending: true });
    const r = await tp.request(cfg, [0x22, 0xFD, 0x54], { timeout: 1000 });
    ok(r.data && r.data[0] === 0x62, '0x78 响应等待：收到后不超时，继续等到正响应');
  }
  {
    const { tp, cfg } = wire(0x7E0, 0x7E8);
    const r = await tp.request(cfg, [0x31, 0x01, 0xFF, 0x00], { timeout: 300 });
    ok(r.nrc === 0x11, '否定响应：返回 NRC 0x11');
  }
  {
    // 安全访问全流程：请求种子 → 算密钥 → 发密钥
    const { tp, cfg } = wire(0x7E0, 0x7E8);
    const seedR = await tp.request(cfg, [0x27, 0x01], { timeout: 1000 });
    const seed = seedR.data.slice(2);
    const key = Diag.runKeyPlugin(`return [seed[0],seed[1],seed[2],seed[3]]`, seed, 1);
    const keyR = await tp.request(cfg, [0x27, 0x02, ...key], { timeout: 1000 });
    ok(seed.length === 4 && keyR.data[0] === 0x67 && keyR.data[1] === 0x02, '安全访问：27 01 取种子 → 27 02 发密钥成功');
  }
  {
    // 我方多帧写 DID（长数据）→ ECU 回流控 → 收确认
    const { tp, cfg } = wire(0x7E0, 0x7E8);
    const r = await tp.request(cfg, [0x2E, 0xFD, 0x60, ...Array.from({ length: 16 }, (_, i) => i)], { timeout: 1000 });
    ok(r.data && r.data[0] === 0x6E, '写 DID：我方多帧发送（ECU 流控）+ 收到确认');
  }
  {
    const { tp, cfg } = wire(0x7E0, 0x7E8);
    const r = await tp.request(cfg, [0x22, 0x00, 0x00], { timeout: 150 });
    // ECU 对未知 DID 回 7F 11，这里确认超时逻辑另测：换一个不回应的 respId
    const dead = new Diag.IsoTp({ send: () => { }, log: () => { } });
    const r2 = await dead.request({ req: 0x7E0, resp: 0x7E8, fd: false, pad: 0 }, [0x3E, 0x80], { timeout: 120 });
    ok(r2.timeout === true, 'ECU 不响应：超时返回');
  }
  console.log(`\n全部通过（${pass} 项）`);
})();
