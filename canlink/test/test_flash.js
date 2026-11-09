// 刷写引擎自测：对着模拟刷写 ECU 跑完整 UDS 刷写流程（会话 / 安全 / 预处理 / 静默整车 / 指纹 /
// 34-36-37 分段下载 / 校验 / 复位 / 恢复），核对收到的刷写字节和原文件一致；另测流控 BS 分块、失败恢复。
const assert = require('assert');
const Diag = require('../../docs/canlink/diag.js');
const Flash = require('../../docs/canlink/flash.js');
let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('✓', m); pass++; };

// 模拟刷写 ECU：物理 reqId/respId，功能寻址 funcId（功能帧只记录、不回）。opt.failOn(req) 返回 true 时回否定码。
function makeFlashEcu(reqId, respId, funcId, opt = {}) {
  let rx = null;
  const ecu = { onTx: null, received: [], funcMsgs: [], downloads: [], failOn: opt.failOn };
  const sendResp = payload => {
    const frames = Diag.buildFrames({ fd: false, pad: 0 }, payload);
    ecu._pending = { frames, idx: 1 };
    ecu.onTx({ id: respId, data: frames[0] });
    if (frames.length === 1) ecu._pending = null;
  };
  ecu.feed = m => {
    const id = m.id & 0x1FFFFFFF, d = m.data;
    if (id === funcId) { const n = d[0] & 0x0F; ecu.funcMsgs.push(Array.from(d.slice(1, 1 + n))); return; }
    if (id !== reqId) return;
    const type = d[0] >> 4;
    if (type === 3) { if (ecu._pending) { const p = ecu._pending; ecu._pending = null; for (let i = p.idx; i < p.frames.length; i++) ecu.onTx({ id: respId, data: p.frames[i] }); } return; }
    let req;
    if (type === 0) { let n = d[0] & 0x0F, s = 1; if (n === 0 && d.length > 8) { n = d[1]; s = 2; } req = d.slice(s, s + n); }  // 含 FD 转义单帧
    else if (type === 1) { const n = ((d[0] & 0x0F) << 8) | d[1]; rx = { buf: [...d.slice(2)], n }; ecu.onTx({ id: respId, data: Uint8Array.of(0x30, 0, 0) }); return; }
    else if (type === 2) { if (!rx) return; rx.buf.push(...d.slice(1)); if (rx.buf.length >= rx.n) { req = Uint8Array.from(rx.buf.slice(0, rx.n)); rx = null; } else return; }
    if (!req) return;
    respond(req);
  };
  function respond(req) {
    const sid = req[0];
    if (ecu.failOn && ecu.failOn(req)) { sendResp([0x7F, sid, 0x72]); return; }
    if (sid === 0x10) sendResp([0x50, req[1], 0x00, 0x32, 0x01, 0xF4]);
    else if (sid === 0x11) sendResp([0x51, req[1]]);
    else if (sid === 0x27 && (req[1] & 1)) sendResp([0x67, req[1], 0x11, 0x22, 0x33, 0x44]);
    else if (sid === 0x27) sendResp([0x67, req[1]]);
    else if (sid === 0x31) sendResp([0x71, req[1], req[2], req[3], 0x00]);
    else if (sid === 0x2E) sendResp([0x6E, req[1], req[2]]);
    else if (sid === 0x34) { const alen = 4; ecu.downloads.push(req.slice(3, 3 + alen)); sendResp([0x74, 0x20, 0x00, 0x82]); }  // maxBlock 0x82=130
    else if (sid === 0x36) { ecu.received.push(...Array.from(req.slice(2))); sendResp([0x76, req[1]]); }
    else if (sid === 0x37) sendResp([0x77]);
    else sendResp([0x7F, sid, 0x11]);
  }
  return ecu;
}

function wireFlash(opt) {
  const reqId = 0x7E0, respId = 0x7E8, funcId = 0x7DF;
  const ecu = makeFlashEcu(reqId, respId, funcId, opt);
  const tp = new Diag.IsoTp({ send: f => ecu.feed(f), log: () => { } });
  ecu.onTx = f => tp.onFrame(f);
  return { tp, ecu, cfg: { req: reqId, resp: respId, func: funcId, fd: !!(opt && opt.fd), brs: !!(opt && opt.fd), ext: false, pad: 0 } };
}

const seg = (addr, len, f) => ({ addr, data: Uint8Array.from({ length: len }, (_, i) => f(i) & 0xFF) });

(async () => {
  // ---- 完整刷写流程 ----
  {
    const { tp, ecu, cfg } = wireFlash();
    const driver = { type: 'bin', segs: [seg(0x08010000, 200, i => i)] };
    const app = { type: 'bin', segs: [seg(0x08020000, 300, i => i * 3)] };
    const r = await Flash.runFlash({
      tp, cfg, files: { driver, app }, keyPlugin: `return [seed[0]^0x11,seed[1],seed[2],seed[3]];`,
      tester: [1, 2, 3, 4], Diag, hooks: { log: () => { } },
    });
    ok(r.ok === true, '完整刷写流程跑通（默认流程，Driver + App）');
    const want = [...Array.from(driver.segs[0].data), ...Array.from(app.segs[0].data)];
    ok(ecu.received.length === want.length && ecu.received.every((b, i) => b === want[i]), 'ECU 收到的刷写字节和原文件逐字节一致');
    ok(ecu.downloads.length === 2, '两段各发了一次 34 请求下载');
    ok(ecu.funcMsgs.some(x => x[0] === 0x85 && x[1] === 0x82), '静默阶段发过功能寻址关闭 DTC（85 82）');
    ok(ecu.funcMsgs.some(x => x[0] === 0x10 && x[1] === 0x81), '收尾发过功能寻址恢复默认会话（10 81）');
  }

  // ---- 只刷 App（没有 Driver 段也能跑，流程里 Driver 步会报“没有刷写数据”——改流程去掉 Driver 步）----
  {
    const { tp, ecu, cfg } = wireFlash();
    const flow = JSON.parse(JSON.stringify(Flash.DEFAULT_FLOW));
    flow.steps = flow.steps.filter(s => !(s.op === 'flash' && s.file === 'driver'));
    const app = { type: 'bin', segs: [seg(0x08020000, 130, i => i + 1)] };
    const r = await Flash.runFlash({ tp, cfg, flow, files: { app }, keyPlugin: `return [0,0,0,0];`, tester: [9], Diag, hooks: { log: () => { } } });
    ok(r.ok === true && ecu.received.length === 130, '去掉 Driver 步后只刷 App 也能跑通');
  }

  // ---- CAN FD 控制器：FD 转义单帧 + FD 多帧（首帧 64 字节）----
  {
    const { tp, ecu, cfg } = wireFlash({ fd: true });
    const app = { type: 'bin', segs: [seg(0x08020000, 300, i => i * 5)] };
    const r = await Flash.runFlash({ tp, cfg, flow: (() => { const f = JSON.parse(JSON.stringify(Flash.DEFAULT_FLOW)); f.steps = f.steps.filter(s => !(s.op === 'flash' && s.file === 'driver')); return f; })(), files: { app }, keyPlugin: `return [seed[0],seed[1],seed[2],seed[3]];`, tester: [1, 2, 3, 4], Diag, hooks: { log: () => { } } });
    ok(r.ok === true && ecu.received.length === 300, 'CAN FD 控制器：含 FD 转义单帧和 FD 多帧也能刷通');
  }

  // ---- 中途失败 + 自动恢复整车 ----
  {
    const { tp, ecu, cfg } = wireFlash({ failOn: req => req[0] === 0x36 });  // 传输数据时 ECU 否定
    const app = { type: 'bin', segs: [seg(0x08020000, 100, i => i)] };
    const r = await Flash.runFlash({ tp, cfg, flow: (() => { const f = JSON.parse(JSON.stringify(Flash.DEFAULT_FLOW)); f.steps = f.steps.filter(s => !(s.op === 'flash' && s.file === 'driver')); return f; })(), files: { app }, keyPlugin: `return [1,2,3,4];`, tester: [1], Diag, hooks: { log: () => { } } });
    ok(r.ok === false, '传输失败 → 刷写返回失败');
    ok(ecu.funcMsgs.some(x => x[0] === 0x28 && x[1] === 0x80 && x[2] === 0x03), '失败后发过恢复接收报文（28 80 03）');
    ok(ecu.funcMsgs.filter(x => x[0] === 0x10 && x[1] === 0x81).length >= 1, '失败后恢复默认会话');
  }

  // ---- 手动停止 ----
  {
    const { tp, cfg } = wireFlash();
    const app = { type: 'bin', segs: [seg(0x08020000, 100, i => i)] };
    const r = await Flash.runFlash({ tp, cfg, files: { app }, keyPlugin: `return [0,0,0,0];`, tester: [0], Diag, hooks: { log: () => { }, shouldStop: () => true } });
    ok(r.ok === false && /停止/.test(r.error), 'shouldStop 返回 true → 立刻停止');
  }

  // ---- 流控 BS 分块：ECU 要求每块 2 帧，验证我方分块把连续帧发完 ----
  {
    let cfSeen = 0;
    const fc = () => setTimeout(() => tp.onFrame({ id: 0x7E8, data: Uint8Array.of(0x30, 2, 0) }), 0);  // 流控异步到（真实环境也是）
    const tp = new Diag.IsoTp({
      send: f => {
        const d = f.data, type = d[0] >> 4;
        if (type === 1) fc();                                   // 首帧 → 回 FC（BS=2）
        else if (type === 2) { cfSeen++; if (cfSeen % 2 === 0) fc(); }  // 每收 2 帧回一次 FC
      }, log: () => { },
    });
    const payload = Array.from({ length: 30 }, (_, i) => i);   // 30 字节 → 首帧 6 + 4 连续帧
    await tp.request({ req: 0x7E0, resp: 0x7E8, fd: false, pad: 0 }, payload, { timeout: 300 });
    ok(cfSeen === 4, '流控 BS=2：30 字节分 4 个连续帧，按块全部发出');
  }

  console.log(`\n全部通过（${pass} 项）`);
})();
