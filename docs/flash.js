// 通用刷写引擎（阶段 3）：把刷写流程写成可配置的步骤表，不同供应商 / 控制器换一份配置就能刷。
// 复用 diag.js 的实时 ISO-TP 和安全算法插件；文件解析用 flashfile.js。
// 纯流程逻辑，不碰界面（进度 / 日志通过回调报出去），可在 node 里对着模拟 ECU 自测。
// 控制器 ID、安全算法、例程 / DID 清单、指纹诊断仪编号都由用户在设备上填 / 加载，不进仓库。
(() => {
  const hx = v => v.toString(16).toUpperCase().padStart(2, '0');
  const parseHex = t => {
    const h = String(t).replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
    if (h.length % 2) throw new Error('数据要按字节写（两位十六进制一个字节）');
    const a = []; for (let i = 0; i < h.length; i += 2) a.push(parseInt(h.substr(i, 2), 16));
    return a;
  };
  // 大端把数值拆成 len 个字节
  const nBytes = (v, len) => { const a = new Array(len); for (let i = len - 1; i >= 0; i--) { a[i] = v & 0xFF; v = Math.floor(v / 256); } return a; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // 默认刷写流程：标准 UDS 刷写顺序（和常见供应商工具一致）。用户可在界面里改。
  // op 见下方 runFlash 的 switch；data 是十六进制字节；wait 是该步之后的等待毫秒。
  // disablesBus 标记“之后整车其他控制器被静默”，中途失败要跑 recovery 恢复。
  const DEFAULT_FLOW = {
    alfid: 0x44,          // 请求下载的地址/长度格式：高 4 位=地址字节数，低 4 位=长度字节数
    timeout: 5000,        // 单条 UDS 等待毫秒（擦除 / 校验慢，ECU 会回 0x78 自动续时）
    stepGap: 100,         // 每步之间至少隔多少毫秒（原厂工具每步隔 100 ms；走网关时功能寻址后紧跟物理请求会被网关丢掉）
    steps: [
      { op: 'req', name: '进扩展会话', data: '10 03' },
      { op: 'func', name: '功能寻址扩展会话', data: '10 83' },
      { op: 'tp_on', name: '开始保持在线（3E 80）', interval: 2000 },
      { op: 'security', name: '安全访问（默认会话）', level: 1 },
      { op: 'req', name: '编程预处理', data: '31 01 02 03' },
      { op: 'func', name: '关闭 DTC 记录', data: '85 82', disablesBus: true },
      { op: 'func', name: '停止接收报文', data: '28 83 03' },
      { op: 'func', name: '停止发送报文', data: '28 83 01' },
      { op: 'req', name: '进编程会话', data: '10 02', wait: 100 },
      { op: 'security', name: '安全访问（编程会话）', level: 1 },
      { op: 'fingerprint', name: '写指纹（日期 + 诊断仪编号）', did: 'F1 84' },
      { op: 'flash', name: '刷写 Driver', file: 'driver', activate: true },
      { op: 'flash', name: '刷写 App', file: 'app', erase: true },
      { op: 'req', name: '校验 App 可用', data: '31 01 FF 01' },
      { op: 'req', name: 'ECU 复位', data: '11 03', wait: 3000 },
      { op: 'func', name: '恢复接收报文', data: '28 80 03' },
      { op: 'func', name: '恢复发送报文', data: '28 80 01' },
      { op: 'func', name: '恢复 DTC 记录', data: '85 81' },
      { op: 'func', name: '恢复默认会话', data: '10 81' },
    ],
    // 中途失败且已静默整车时，按顺序发这些功能寻址指令，把别的控制器恢复过来
    recovery: ['28 80 03', '28 80 01', '85 81', '10 81'],
  };

  // 运行一次刷写。
  // tp: diag.js 的 IsoTp 实例（有 request / sendNoWait / cancel）
  // cfg: 当前控制器配置 { req, resp, func, fd, brs, ext, pad }
  // flow: 流程配置（同 DEFAULT_FLOW）
  // files: { driver: {segs}, app: {segs} }（flashfile.js 解析出来的，可只给一个）
  // keyPlugin: 安全算法 JS 代码（字符串），security 步用
  // tester: 指纹里的诊断仪编号（字节数组），fingerprint 步用；界面层优先自动获取，取不到才用内置写死值
  // Diag: diag.js 的 API（runKeyPlugin），node 自测时传入；浏览器里默认取 window.Diag
  // hooks: { onStep(i,total,step,status,msg), onProgress(frac,text), log(msg,cls), shouldStop() }
  async function runFlash(o) {
    const { tp, cfg, files, keyPlugin, hooks = {} } = o;
    const flow = o.flow || DEFAULT_FLOW;
    const Diag = o.Diag || (typeof window !== 'undefined' ? window.Diag : null);
    const tester = o.tester && o.tester.length ? Array.from(o.tester) : [0, 0, 0, 0];
    const timeout = flow.timeout || 5000;
    // 步间间隔：流程里没写就按 100 ms（内置 / 旧版流程没有这个字段也照样生效）
    const stepGap = flow.stepGap != null ? Math.max(0, +flow.stepGap || 0) : 100;
    const alfid = flow.alfid || 0x44;
    const addrLen = (alfid >> 4) & 0xF, lenLen = alfid & 0xF;
    const log = (m, c) => hooks.log && hooks.log(m, c);
    const phys = cfg;
    const func = { ...cfg, req: cfg.func };
    let inFlight = false, tpTimer = null, busDisabled = false;

    const checkStop = () => { if (hooks.shouldStop && hooks.shouldStop()) throw new Error('已手动停止'); };

    // 物理寻址请求，等正响应；否定 / 超时 / 出错都抛异常
    async function uds(payload, to) {
      checkStop();
      inFlight = true;
      let r;
      try { r = await tp.request(phys, Uint8Array.from(payload), { timeout: to || timeout }); }
      finally { inFlight = false; }
      if (r.timeout) throw new Error('ECU 无响应（超时）');
      if (r.error) throw new Error(r.error);
      if (r.nrc !== undefined) throw new Error(`否定响应 0x${hx(r.nrc)}：${r.nrcText || ''}`);
      if (!r.data || r.data[0] !== (payload[0] | 0x40)) throw new Error('应答不是对应的正响应');
      return r.data;
    }
    const sendFunc = payload => { checkStop(); tp.sendNoWait(func, Uint8Array.from(payload)); };

    function startTp(interval) {
      stopTp();
      tpTimer = setInterval(() => { if (!inFlight) { try { tp.sendNoWait(func, Uint8Array.of(0x3E, 0x80)); } catch (e) { /* ignore */ } } }, interval || 2000);
    }
    function stopTp() { if (tpTimer) { clearInterval(tpTimer); tpTimer = null; } }

    async function security(level) {
      const reqSub = 2 * level - 1, keySub = 2 * level;
      const sd = await uds([0x27, reqSub]);
      if (sd[0] !== 0x67) throw new Error('27 应答异常');
      const seed = sd.slice(2);
      if (seed.every(b => b === 0)) { log('种子全 0，可能已解锁', 'good'); return; }
      if (!keyPlugin) throw new Error('没加载安全算法（到“诊断”页贴算法插件）');
      const key = Diag.runKeyPlugin(keyPlugin, seed, level, sd);
      if (!key || !key.length) throw new Error('安全算法没返回 key');
      await uds([0x27, keySub, ...Array.from(key)]);
    }

    async function fingerprint(step) {
      const now = new Date();
      const did = parseHex(step.did || 'F1 84');
      await uds([0x2E, ...did, now.getFullYear() % 100, now.getMonth() + 1, now.getDate(), ...tester]);
    }

    // 总进度按这次流程里所有要刷的文件一起算，跨 Driver / App 单调走到 100%
    const flashSteps = (flow.steps || []).filter(s => s.op === 'flash' && files && files[s.file]);
    let grandTotal = 0;
    for (const s of flashSteps) grandTotal += (files[s.file].segs || []).reduce((n, x) => n + x.data.length, 0);
    let grandDone = 0;

    // 刷一个文件：每段 34 请求下载 → 36 分块传输 → 37 退出；可选先擦除、后激活
    async function flashFile(segs, step) {
      if (!segs || !segs.length) throw new Error('没有刷写数据（文件没选或解析为空）');
      const totalBytes = segs.reduce((s, x) => s + x.data.length, 0);
      let doneBytes = 0;
      for (let si = 0; si < segs.length; si++) {
        const seg = segs[si];
        const addr = seg.addr >>> 0, len = seg.data.length;
        log(`第 ${si + 1}/${segs.length} 段：地址 0x${addr.toString(16).toUpperCase()}，${len} 字节`);
        if (step.erase) { log('擦除…'); await uds([0x31, 0x01, 0xFF, 0x00, ...nBytes(addr, 4), ...nBytes(len, 4)]); }
        // 34 请求下载：00 ALFID 地址 长度
        const rd = await uds([0x34, 0x00, alfid, ...nBytes(addr, addrLen), ...nBytes(len, lenLen)]);
        const nn = rd[1] >> 4;
        if (nn < 1 || nn > 4 || rd.length < 2 + nn) throw new Error('34 回复里取不到块长度');
        let maxBlock = 0; for (let i = 0; i < nn; i++) maxBlock = (maxBlock << 8) | rd[2 + i];
        maxBlock = Math.min(maxBlock, 4095);          // 多帧最长 4095
        if (maxBlock < 3) throw new Error('34 回复的块长度无效：' + maxBlock);
        const chunk = maxBlock - 2;                   // 减掉 36 和块序号两个字节
        log(`ECU 允许每块最多 ${maxBlock} 字节`);
        let off = 0, sn = 1;
        while (off < len) {
          const part = seg.data.subarray(off, off + chunk);
          const rt = await uds([0x36, sn & 0xFF, ...Array.from(part)]);
          if (rt.length < 2 || rt[1] !== (sn & 0xFF)) throw new Error(`36 块序号不对（在 ${off}）`);
          off += part.length; doneBytes += part.length; grandDone += part.length; sn = (sn + 1) & 0xFF;
          const frac = grandTotal ? grandDone / grandTotal : doneBytes / totalBytes;
          const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
          hooks.onProgress && hooks.onProgress(frac, `${pct}%`);
          if (step.blockWait) await sleep(step.blockWait);
        }
        await uds([0x37]);                            // 37 退出传输
        if (step.activate) { log('激活编程…'); await uds([0x31, 0x01, 0x02, 0x02, ...nBytes(addr, 4)]); }
        log(`第 ${si + 1}/${segs.length} 段完成`, 'good');
      }
    }

    const steps = flow.steps || [];
    let sentReq = false;
    try {
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        checkStop();
        hooks.onStep && hooks.onStep(i, steps.length, s, 'run');
        log('▶ ' + (s.name || s.op));
        switch (s.op) {
          case 'req':
            if (!sentReq) {
              // 第一条物理请求超时重发一次：刚开始时手机 / USB 可能还有积压，第一条应答容易丢
              sentReq = true;
              try { await uds(parseHex(s.data), s.timeout); }
              catch (e) { if (!/超时/.test(e.message)) throw e; log('第一条请求没等到应答，重发一次', 'warn'); await uds(parseHex(s.data), s.timeout); }
            } else await uds(parseHex(s.data), s.timeout);
            break;
          case 'func': sendFunc(parseHex(s.data)); if (s.disablesBus) busDisabled = true; break;
          case 'security': await security(s.level || 1); break;
          case 'fingerprint': await fingerprint(s); break;
          case 'tp_on': startTp(s.interval); break;
          case 'tp_off': stopTp(); break;
          case 'flash': await flashFile(files && files[s.file] && files[s.file].segs, s); break;
          case 'delay': await sleep(s.ms || 100); break;
          default: throw new Error('未知步骤：' + s.op);
        }
        hooks.onStep && hooks.onStep(i, steps.length, s, 'ok');
        const w = Math.max(s.wait || 0, i < steps.length - 1 ? stepGap : 0);
        if (w) await sleep(w);
      }
      stopTp();
      log('✅ 全部完成', 'good');
      return { ok: true };
    } catch (e) {
      stopTp();
      log('❌ 失败：' + e.message, 'bad');
      hooks.onStep && hooks.onStep(-1, steps.length, null, 'fail', e.message);
      // 中途失败且整车已静默：恢复其他控制器，免得一车控制器都不收发
      if (busDisabled && flow.recovery && flow.recovery.length) {
        log('刷写未完成，正在恢复整车其他控制器的通信和 DTC…', 'warn');
        try { for (const d of flow.recovery) { tp.sendNoWait(func, Uint8Array.from(parseHex(d))); await sleep(60); } log('已恢复。被刷的 ECU 可能停在 Boot，请重新刷写。', 'warn'); }
        catch (e2) { log('恢复失败：' + e2.message + '，请给整车重新上下电。', 'bad'); }
      }
      return { ok: false, error: e.message };
    }
  }

  const API = { runFlash, DEFAULT_FLOW, parseHex, nBytes };
  if (typeof module !== 'undefined') module.exports = API;
  if (typeof window !== 'undefined') window.Flash = API;
})();
