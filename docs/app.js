// CAN 工具主程序：连接、通道设置、在线报文、发送、录制、刷固件。
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hx = (v, w) => v.toString(16).toUpperCase().padStart(w || 2, '0');
  const store = {
    get(k, d) { try { const v = localStorage.getItem('canlink.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('canlink.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };

  // ---------------- 状态 ----------------
  const S = {
    dev: null, fw: null, open: false, silent: true, nominal: 500000, data: 2000000, fdOn: true,
    clock: new Slcan.Clock(), hostT0: 0, lastT: 0, tOffset: 0, ppm: 0, clockLocked: false,
    ids: new Map(), scroll: [], recent: [], paused: false, view: 'fixed', filter: null,
    stats: { frames: 0, bits: 0, lastFrames: 0, lastBits: 0, lastTime: 0, fps: 0, load: 0 },
    rec: null, recording: false, recT0: 0, pending: null, statusTimer: null, wakeLock: null,
  };
  const SCROLL_MAX = 400;

  const LOG_LINES = [];               // 全程日志（导出用，上限 1 万条）；界面上只显示最近 60 条
  function log(msg, cls) {
    const t = new Date().toTimeString().slice(0, 8);
    LOG_LINES.push(`${t} ${msg}`);
    if (LOG_LINES.length > 10000) LOG_LINES.splice(0, LOG_LINES.length - 10000);
    const el = $('log');
    el.insertAdjacentHTML('beforeend', `<div class="${cls || ''}">${t} ${esc(msg)}</div>`);
    while (el.childNodes.length > 60) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }
  // 页面自身的报错也记进日志，实测出问题时导出就能看到
  window.addEventListener('error', e => { try { log(`页面错误：${e.message || e.type}`, 'bad'); } catch (_) { /* ignore */ } });
  window.addEventListener('unhandledrejection', e => { try { log(`未处理的异常：${(e.reason && e.reason.message) || e.reason}`, 'bad'); } catch (_) { /* ignore */ } });

  // ---------------- 页签 ----------------
  $('tabs').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    for (const x of $('tabs').children) x.classList.toggle('on', x === b);
    for (const s of document.querySelectorAll('main > section')) s.classList.toggle('on', s.id === b.dataset.t);
    if (b.dataset.t === 'trace') { if (S.tmode === 'offline') requestAnimationFrame(fitViewer); else renderTrace(true); }
    if (b.dataset.t === 'send') renderResp(true);
    if (b.dataset.t === 'flash') flashCtrlHint();
    store.set('tab', b.dataset.t);
  });
  function seg(id, cb) {
    $(id).addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      for (const x of $(id).children) x.classList.toggle('on', x === b);
      cb(b.dataset.v);
    });
  }
  function setSeg(id, v) { for (const x of $(id).children) x.classList.toggle('on', x.dataset.v === String(v)); }

  // ---------------- 设置（存在本机） ----------------
  const cfgIds = ['nomRate', 'nomSp', 'fdOn', 'dataRate', 'dataSp', 'niso'];
  for (const id of cfgIds) {
    const el = $(id), v = store.get('cfg.' + id, null);
    if (v !== null) { if (el.type === 'checkbox') el.checked = v; else el.value = v; }
    el.addEventListener('change', () => { store.set('cfg.' + id, el.type === 'checkbox' ? el.checked : el.value); updateTiming(); reopenIfOpen(); });
  }
  S.silent = store.get('cfg.silent', false);   // 默认正常收发
  setSeg('mode', S.silent ? 1 : 0);
  seg('mode', v => { S.silent = v === '1'; store.set('cfg.silent', S.silent); updateSendHint(); reopenIfOpen(); });

  function timings() {
    const clock = (S.fw && S.fw.clock) || 80e6;
    const nom = Slcan.timing(clock, +$('nomRate').value, +$('nomSp').value / 100, 'nominal');
    const dat = Slcan.timing(clock, +$('dataRate').value, +$('dataSp').value / 100, 'data');
    return { nom, dat, fd: $('fdOn').checked };
  }
  const rateText = r => r >= 1e6 ? r / 1e6 + 'M' : r / 1000 + 'k';
  function updateTiming() {
    $('fdRow').style.display = $('fdOn').checked ? '' : 'none';
    const { nom, dat, fd } = timings();
    const f = (t, name) => t ? `${name} ${rateText(t.bitrate)}：分频 ${t.brp}，${t.tq} tq，实际采样点 ${(t.sp * 100).toFixed(1)}%` : `${name}：这个波特率凑不出来`;
    let s = f(nom, '仲裁段');
    if (fd) s += '；' + f(dat, '数据段');
    if (S.fw && !S.fw.vdlink) s += '。原版固件只能用预设（采样点固定 88%，数据段只有 2M / 5M）';
    $('timingInfo').textContent = s;
  }

  // ---------------- 连接 ----------------
  const reader = new Slcan.LineReader(onLine);

  // 等待中的命令是否被这一行应答：want '' = 只等 \r / \a；'*' = 任意一行文字；其他 = 以它开头
  function answers(p, line, isErr) {
    if (p.want === '') return line === '' || isErr;
    if (p.want === '*') return line !== '' || isErr;
    return line.startsWith(p.want) || isErr;
  }
  function onLine(line, isErr) {
    if (S.pending && answers(S.pending, line, isErr)) {
      const p = S.pending; S.pending = null; p.resolve({ line, err: isErr }); return;
    }
    if (line === '' || isErr) return;
    const m = Slcan.parseLine(line, S.fw && S.fw.vdlink ? 2 : 0);
    if (!m) return;
    if (m.kind === 'frame') onFrame(m);
    else if (m.kind === 'status') onStatus(m);
  }

  // 发命令并等回复（只在通道关闭、没有报文时用）
  function cmd(text, want, timeout = 600) {
    return new Promise(resolve => {
      const timer = setTimeout(() => { if (S.pending && S.pending.resolve === done) S.pending = null; resolve(null); }, timeout);
      const done = r => { clearTimeout(timer); resolve(r); };
      S.pending = { want, resolve: done };
      S.dev.write(text + '\r').catch(() => done(null));
    });
  }
  const send = text => S.dev.write(text + '\r');

  // 连接。demo：演示模式；known：已经授权过的设备 / 串口（自动连接用，不弹窗）
  async function connect(demo, known) {
    if (S.connecting) return;
    if (S.dev) await disconnect();
    let t;
    if (demo) t = new DemoTransport();
    else {
      t = known ? known.transport : Transport.pick();
      if (!t) { showNoApi(); return; }
    }
    S.connecting = true;
    const btn = $('btnConn');
    btn.disabled = true;
    if (!known && !demo) $('devInfo').innerHTML = '请在弹出的窗口里选 <b>CANable</b>。窗口里是空的说明没认到设备：点“取消”，检查数据线（要能传数据的线）和 OTG 是否打开，再试一次。';
    t.onData = text => reader.push(text);
    t.onClose = () => { log('设备断开了', 'bad'); cleanup(); };
    try {
      await t.open(known && known.handle);
    } catch (e) {
      S.connecting = false; btn.disabled = false;
      if (e && e.name === 'NotFoundError') { $('devInfo').textContent = '没有选设备。'; return; }
      $('devInfo').innerHTML = `<span class="bad">连接失败：${esc(e.message || e)}</span>`;
      log('连接失败：' + (e.message || e), 'bad');
      return;
    }
    S.dev = t;
    $('noApi').hidden = true;
    await send('C').catch(() => {});
    await new Promise(r => setTimeout(r, 100));
    const r = await cmd('xI', 'xI');
    if (r && r.line && r.line.startsWith('xI')) {
      const info = Slcan.parseLine(r.line, 0);
      S.fw = { vdlink: true, version: info.version, clock: info.clock || 80e6 };
    } else {
      const v = await cmd('V', '*', 400);
      S.fw = { vdlink: false, version: v && v.line ? v.line.trim() : '原版 slcan', clock: 80e6 };
    }
    S.connecting = false; btn.disabled = false;
    $('chipDev').textContent = t.name;
    $('chipDev').classList.add('on');
    const fwText = S.fw.vdlink ? 'vdlink ' + esc(S.fw.version) : '<span class="warn">' + esc(S.fw.version) + '（原版，建议到“设置 → 固件”刷 vdlink）</span>';
    $('devInfo').innerHTML = `已连接：<b>${esc(t.name)}</b><br>固件：${fwText}`;
    $('fwNow').innerHTML = `当前：${esc(t.name)}，${fwText}`;
    log(`已连接 ${t.name}，固件 ${S.fw.vdlink ? 'vdlink ' + S.fw.version : S.fw.version}`);
    updateButtons();
    updateTiming();
    updateSendHint();
    if (S.fw.vdlink) pollStatus();
  }

  async function disconnect() {
    if (!S.dev) return;
    try { if (S.open) await closeChannel(); } catch (e) { /* ignore */ }
    const d = S.dev;
    cleanup();
    try { await d.close(); } catch (e) { /* ignore */ }
    log('已断开');
  }

  function cleanup() {
    stopCyclic();
    if (S.recording) stopRec();
    S.dev = null; S.open = false; S.fw = null; S.connecting = false;
    clearInterval(S.statusTimer); S.statusTimer = null;
    releaseWake();
    $('chipDev').textContent = '未连接'; $('chipDev').classList.remove('on');
    setBusChip();
    $('devInfo').textContent = '未连接。用 USB 数据线连上 CANable 后点“连接设备”。'; $('fwNow').textContent = '当前：未连接';
    updateButtons();
    updateSendHint();
    refreshNoApi();
  }

  function updateButtons() {
    $('btnConn').textContent = S.dev ? '断开设备' : '连接设备';
    $('btnConn').classList.toggle('p', !S.dev);
    $('btnChan').disabled = !S.dev;
    $('btnChan').textContent = S.open ? '关闭通道' : '打开通道';
    $('btnChan').classList.toggle('p', !!S.dev && !S.open);
  }

  function showNoApi() {
    $('noApi').hidden = false;
    $('noApi').innerHTML = '<span class="bad">这个浏览器不能访问 USB 设备（UC、QQ、微信、小米自带浏览器、iPhone 都不行）。' +
      '请用 <b>Chrome</b>（安卓可在应用商店装）或电脑上的 Chrome / Edge 打开。</span>';
  }

  function refreshNoApi() { if (!Transport.pick()) showNoApi(); else $('noApi').hidden = true; }
  $('btnConn').onclick = () => S.dev ? disconnect() : connect(false);
  $('btnDemo').onclick = () => { connect(true); document.querySelector('#tabs button[data-t=rec]').click(); };
  refreshNoApi();

  // 授权过的设备：打开网页、插上设备时自动连接，不用每次选
  async function autoConnect() {
    if (S.dev || S.connecting) return;
    const k = await Transport.known();
    if (k) connect(false, k);
  }
  autoConnect();
  if (navigator.usb && Transport.isAndroid()) navigator.usb.addEventListener('connect', () => setTimeout(autoConnect, 300));
  if (navigator.serial && !Transport.isAndroid()) navigator.serial.addEventListener('connect', () => setTimeout(autoConnect, 300));

  // ---------------- 通道 ----------------
  async function openChannel() {
    if (!S.dev || S.open) return;
    const { nom, dat, fd } = timings();
    if (!nom || (fd && !dat)) { log('波特率凑不出来，到“设置”里换一个采样点或波特率', 'bad'); return; }
    S.fdOn = fd; S.nominal = nom.bitrate; S.data = fd ? dat.bitrate : 0;
    S.configuring = true;
    try { if (!await configure(nom, dat, fd)) return; } finally { S.configuring = false; }
    // 录制中重开通道（改了设置）：时间接着往后走，不从 0 重新算
    S.tOffset = S.recording ? S.lastT + 0.001 : 0;
    S.clock.reset(); S.clock.ppm = S.ppm;
    S.hostT0 = performance.now(); S.lastT = S.tOffset;
    resetStats();
    await send('O');
    S.open = true; S.openSilent = S.silent;
    setBusChip();
    updateButtons();
    log(`通道已打开：${rateText(nom.bitrate)}${fd ? ' / ' + rateText(dat.bitrate) + ' FD' : ''}，${S.silent ? '只听' : '正常收发'}`);
    updateSendHint();
    requestWake();
  }

  async function configure(nom, dat, fd) {
    await new Promise(r => setTimeout(r, 150)); // 等可能还在路上的状态回复
    if (S.fw.vdlink) {
      const steps = [Slcan.timingCmd('nominal', nom), Slcan.timingCmd('data', dat || Slcan.timing(S.fw.clock, 2e6, 0.75, 'data')),
        'xO' + $('niso').value, 'xT' + (S.silent ? 0 : 1)];
      for (const c of steps) {
        const r = await cmd(c, '');
        if (!r || r.err) { log(`设置失败（${c}）`, 'bad'); return false; }
      }
      await send('M' + (S.silent ? 1 : 0));
      await send('Z2');
      // 用最近一次测到的时钟误差修正时间戳
      const st = await cmd('xS', 'xS');
      if (st && st.line) onStatus(Slcan.parseLine(st.line, 0));
    } else {
      const s = Slcan.PRESET_S[nom.bitrate], y = Slcan.PRESET_Y[fd ? dat.bitrate : 2e6];
      if (s === undefined || y === undefined) { log('原版固件不支持这个波特率（数据段只有 2M / 5M）', 'bad'); return false; }
      await send('S' + s); await send('Y' + y); await send('M' + (S.silent ? 1 : 0));
    }
    return true;
  }

  // keepRec：改设置自动重开通道时录制不停；手动关通道、断开设备时录制跟着停
  async function closeChannel(keepRec) {
    if (!S.open) return;
    stopCyclic();
    await send('C');
    if (!keepRec && S.recording) stopRec();
    S.open = false;
    setBusChip();
    updateButtons();
    log('通道已关闭');
    updateSendHint();
    releaseWake();
  }
  $('btnChan').onclick = () => S.open ? closeChannel() : openChannel();

  // 通道开着时改了设置：关掉重开（录制不停）
  async function reopenIfOpen() {
    if (!S.open || S.reopening) return;
    S.reopening = true;
    try {
      await closeChannel(true);
      await openChannel();
    } finally { S.reopening = false; }
  }

  function setBusChip(text, cls) {
    const c = $('chipBus');
    c.classList.remove('on', 'err');
    if (!S.open) { c.textContent = '通道关闭'; return; }
    c.textContent = text || (S.silent ? '只听' : '收发');
    c.classList.add(cls || 'on');
  }

  // 屏幕常亮（手机录制时防止锁屏断开）
  async function requestWake() {
    try { if (navigator.wakeLock && !S.wakeLock) S.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* ignore */ }
  }
  function releaseWake() { try { if (S.wakeLock) S.wakeLock.release(); } catch (e) { /* ignore */ } S.wakeLock = null; }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.open) { S.wakeLock = null; requestWake(); } });

  // ---------------- 状态轮询 ----------------
  function pollStatus() {
    clearInterval(S.statusTimer);
    S.statusTimer = setInterval(() => {
      if (!S.dev || !S.fw || !S.fw.vdlink || S.pending || S.configuring) return;
      send('xS').catch(() => {});
    }, 1000);
  }
  function onStatus(st) {
    if (!st) return;
    if (!S.open) { S.ppm = st.ppm || 0; S.clockLocked = st.clockLocked; } // 通道打开后不再改，免得时间跳
    $('sClk').textContent = `${st.ppm > 0 ? '+' : ''}${st.ppm} ppm${st.clockLocked ? '' : '（校准中）'}`;
    $('sDrop').textContent = String(st.rxDropped);
    if (!st.on) { $('sBus').textContent = '通道关闭'; $('sErr').textContent = '—'; return; }
    const tec = st.ecr & 0xFF, recv = (st.ecr >> 8) & 0x7F, bo = st.psr & 0x80, ep = st.psr & 0x20, ew = st.psr & 0x40;
    const lec = st.psr & 7;
    const LEC = ['', '填充错误', '格式错误', '应答错误', '位1错误', '位0错误', 'CRC 错误', ''];
    let txt = '正常', cls = 'good';
    if (bo) { txt = '离线（Bus Off，正在恢复）'; cls = 'bad'; }
    else if (ep) { txt = '被动错误'; cls = 'bad'; }
    else if (ew) { txt = '错误警告'; cls = 'warn'; }
    if (LEC[lec] && cls !== 'good') txt += '，最近：' + LEC[lec];
    $('sBus').innerHTML = `<span class="${cls}">${txt}</span>`;
    $('sErr').textContent = `${tec} / ${recv}`;
    if (S.open) setBusChip(cls === 'good' ? null : txt.split('，')[0], cls === 'good' ? 'on' : 'err');
  }

  // ---------------- 收到报文 ----------------
  function frameTime(m) {
    if (m.ts !== null && S.fw && S.fw.vdlink) return S.tOffset + S.clock.seconds(m.ts);
    return S.tOffset + (performance.now() - S.hostT0) / 1000;
  }

  function onFrame(m) {
    const t = frameTime(m);
    S.lastT = t;
    m.t = t;
    if (!m.tx && S.tp) S.tp.onFrame(m);   // 喂给 ISO-TP 引擎（只喂收到的，不喂自己的回显）
    S.stats.frames++;
    S.stats.bits += Slcan.frameBits(m, S.nominal, S.data);

    const key = (m.ext ? 'x' : '') + m.id + (m.tx ? 't' : '');
    let e = S.ids.get(key);
    if (!e) { e = { key, id: m.id, ext: m.ext, tx: m.tx, cnt: 0, period: 0, lastT: t, chg: [] }; S.ids.set(key, e); }
    else {
      const dt = t - e.lastT;
      e.period = e.period ? e.period * 0.8 + dt * 0.2 : dt;
      const old = e.data;
      for (let i = 0; i < m.data.length; i++) if (!old || old[i] !== m.data[i]) e.chg[i] = t;
    }
    e.cnt++; e.lastT = t; e.fd = m.fd; e.brs = m.brs; e.rtr = m.rtr; e.data = m.data; e.dlc = m.dlc;

    S.recent.push(m);
    if (S.recent.length > 2000) S.recent.splice(0, 1000);
    if (!S.paused) {
      S.scroll.push(m);
      if (S.scroll.length > SCROLL_MAX * 2) S.scroll.splice(0, S.scroll.length - SCROLL_MAX);
    }
    if (S.recording) S.rec.push(t - S.recT0, m);
  }

  function resetStats() {
    Object.assign(S.stats, { frames: 0, bits: 0, lastFrames: 0, lastBits: 0, lastTime: performance.now(), fps: 0, load: 0 });
  }
  setInterval(() => {
    const st = S.stats, now = performance.now(), dt = (now - st.lastTime) / 1000;
    if (dt <= 0) return;
    st.fps = (st.frames - st.lastFrames) / dt;
    st.load = S.nominal ? (st.bits - st.lastBits) / dt / S.nominal : 0;
    st.lastFrames = st.frames; st.lastBits = st.bits; st.lastTime = now;
    if (S.open) {
      $('sFps').textContent = `${Math.round(st.fps)} 帧/秒`;
      $('sLoad').textContent = `${(st.load * 100).toFixed(1)} %`;
      $('stat').textContent = `${Math.round(st.fps)} 帧/秒 · 负载 ${(st.load * 100).toFixed(0)}%`;
    } else $('stat').textContent = '';
    updateRecInfo();
  }, 1000);

  // ---------------- 查看：在线报文 / 离线数据 ----------------
  // 离线数据 = 通用版（GNL）的数据分析页（viewer/），嵌在 iframe 里；DBC、诊断问卷自己加载
  let viewerReady = false, viewerQueue = null;
  window.addEventListener('message', e => {
    if (e.origin !== location.origin || !e.data || e.data.type !== 'canlink-viewer-ready') return;
    viewerReady = true;
    if (viewerQueue) { postToViewer(viewerQueue); viewerQueue = null; }
  });
  function postToViewer(file) {
    file.arrayBuffer().then(buf => $('viewerFrame').contentWindow.postMessage({ type: 'canlink-open', name: file.name, buf }, location.origin, [buf]));
  }
  function fitViewer() {
    const f = $('viewerFrame'), top = f.getBoundingClientRect().top;
    f.style.height = Math.max(400, window.innerHeight - Math.max(top, 0) - 12) + 'px';
  }
  window.addEventListener('resize', () => { if (!$('offlineBox').hidden) fitViewer(); });

  // 进离线数据前通道要关：报文还在进来时分析的数据不完整，也避免手机同时干两件重活
  async function needClosed() {
    if (!S.open) return true;
    if (!confirm('要先关闭通道才能查看离线数据。现在关闭通道吗？' + (S.recording ? '\n（录制会停止，录好的数据还在。）' : ''))) return false;
    await closeChannel();
    if (S.recording) stopRec();
    return true;
  }
  async function setTraceMode(mode, file) {
    if (mode === 'offline' && !await needClosed()) { setSeg('tmode', S.tmode || 'online'); return false; }
    S.tmode = mode;
    setSeg('tmode', mode);
    $('onlineBox').hidden = mode !== 'online';
    $('offlineBox').hidden = mode !== 'offline';
    $('tmodeHint').textContent = mode === 'offline' ? '打开 blf / asc 文件，或在“录制”页点“查看”。车型在下面选。' : '';
    if (mode === 'offline') {
      const f = $('viewerFrame');
      if (!f.src) { viewerReady = false; f.src = 'viewer/'; }
      requestAnimationFrame(fitViewer);
      if (file) { if (viewerReady) postToViewer(file); else viewerQueue = file; }
    } else renderTrace(true);
    return true;
  }
  seg('tmode', v => setTraceMode(v));
  S.tmode = 'online';

  // ---------------- 报文显示 ----------------
  seg('view', v => { S.view = v; renderTrace(true); });
  $('btnPause').onclick = () => { S.paused = !S.paused; $('btnPause').textContent = S.paused ? '继续' : '暂停'; };
  $('btnClear').onclick = () => { S.ids.clear(); S.scroll = []; renderTrace(true); };
  $('filter').addEventListener('input', () => { S.filter = parseFilter($('filter').value); renderTrace(true); });
  $('filter').value = store.get('filter', '');
  S.filter = parseFilter($('filter').value);
  $('filter').addEventListener('change', () => store.set('filter', $('filter').value));

  function parseFilter(text) {
    const parts = text.split(/[\s,，;]+/).filter(Boolean);
    if (!parts.length) return null;
    const ranges = [];
    for (const p of parts) {
      const m = /^([0-9a-f]+)(?:-([0-9a-f]+))?$/i.exec(p.replace(/^0x/i, ''));
      if (!m) continue;
      const a = parseInt(m[1], 16), b = m[2] ? parseInt(m[2], 16) : a;
      ranges.push([Math.min(a, b), Math.max(a, b)]);
    }
    return ranges.length ? ranges : null;
  }
  const pass = id => !S.filter || S.filter.some(([a, b]) => id >= a && id <= b);
  const idText = (id, ext) => ext ? hx(id, 8) : hx(id, 3);
  const typeText = e => e.rtr ? '远程' : e.fd ? (e.brs ? 'FD+BRS' : 'FD') : 'CAN';

  let lastRender = 0;
  function renderTrace(force) {
    if (!$('trace').classList.contains('on') || S.tmode !== 'online') return;
    const now = performance.now();
    if (!force && (S.paused || now - lastRender < 250)) return;
    lastRender = now;
    const box = $('traceBox');
    if (S.view === 'fixed') {
      const rows = [...S.ids.values()].filter(e => pass(e.id)).sort((a, b) => (a.ext - b.ext) || (a.id - b.id) || (a.tx - b.tx));
      const tNow = S.lastT;
      let h = '<table><thead><tr><th>ID</th><th class="hide-s">类型</th><th>数据</th><th class="r">周期</th><th class="r">次数</th></tr></thead><tbody>';
      for (const e of rows) {
        let d = '';
        if (e.data) for (let i = 0; i < e.data.length; i++) {
          const s = hx(e.data[i]);
          d += (i ? ' ' : '') + (e.chg[i] !== undefined && tNow - e.chg[i] < 1 ? `<span class="ch">${s}</span>` : s);
        }
        h += `<tr class="${e.tx ? 'tx' : ''}"><td>${e.tx ? '→' : ''}${idText(e.id, e.ext)}</td><td class="hide-s">${typeText(e)} ${e.data ? e.data.length : 0}</td>` +
          `<td class="d">${d}</td><td class="r">${e.period ? (e.period * 1000).toFixed(e.period < 0.1 ? 1 : 0) : '—'}</td><td class="r">${e.cnt}</td></tr>`;
      }
      box.innerHTML = h + '</tbody></table>';
      $('traceInfo').textContent = `${rows.length} 个 ID（共 ${S.ids.size} 个）。“→”是本机发出的；黄色是 1 秒内变化的字节；周期单位 ms。`;
    } else {
      const list = S.scroll.filter(m => pass(m.id)).slice(-SCROLL_MAX);
      let h = '<table><thead><tr><th>时间 s</th><th>ID</th><th class="hide-s">类型</th><th>数据</th></tr></thead><tbody>';
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        h += `<tr class="${m.tx ? 'tx' : ''}"><td>${m.t.toFixed(4)}</td><td>${m.tx ? '→' : ''}${idText(m.id, m.ext)}</td>` +
          `<td class="hide-s">${typeText(m)} ${m.data.length}</td><td class="d">${Array.from(m.data, b => hx(b)).join(' ')}</td></tr>`;
      }
      box.innerHTML = h + '</tbody></table>';
      $('traceInfo').textContent = `最近 ${list.length} 帧，新的在上面。`;
    }
  }
  setInterval(() => renderTrace(false), 250);

  // ---------------- 诊断（阶段 2） ----------------
  const parseId = v => parseInt(String(v).trim().replace(/^0x/i, ''), 16);
  const parseHex = t => {
    const h = String(t).replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
    if (h.length % 2) throw new Error('数据要按字节写（两位十六进制一个字节）');
    const a = new Uint8Array(h.length / 2);
    for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16);
    return a;
  };
  const hexs = a => Array.from(a, b => hx(b)).join(' ');

  // 控制器配置（本机保存，可导入导出；ID 等保密内容由用户填，不进仓库）
  let ctrls = store.get('ctrls', null);
  if (!ctrls || !ctrls.length) ctrls = [{ name: '控制器 1', req: '7E0', resp: '7E8', func: '7DF', pad: '00', fd: true, brs: true, ext: false }];
  let curCtrl = Math.min(store.get('ctrlCur', 0), ctrls.length - 1);
  const saveCtrls = () => { store.set('ctrls', ctrls); store.set('ctrlCur', curCtrl); };
  function curCfg() {
    const c = ctrls[curCtrl] || {};
    const pad = String(c.pad || '').trim();
    return { req: parseId(c.req), resp: parseId(c.resp), func: c.func ? parseId(c.func) : null,
      fd: !!c.fd, brs: c.brs !== false, ext: !!c.ext, pad: pad ? parseId(pad) & 0xFF : 0 };
  }
  function linkCBrs() { const b = $('cBrs'); b.disabled = !$('cFd').checked; b.closest('label').classList.toggle('off', b.disabled); }
  $('cFd').addEventListener('change', linkCBrs);
  function renderCtrlSel() {
    $('ctrlSel').innerHTML = ctrls.map((c, i) => `<option value="${i}"${i === curCtrl ? ' selected' : ''}>${esc(c.name || ('控制器 ' + (i + 1)))}</option>`).join('');
    fillCtrlFields();
  }
  function fillCtrlFields() {
    const c = ctrls[curCtrl] || {};
    $('cPair').value = [c.req, c.resp].filter(x => x).join('/');
    $('cFunc').value = c.func || ''; $('cPad').value = c.pad || ''; $('cFd').checked = !!c.fd;
    $('ctrlDel').disabled = !!c.builtin;
    $('cBrs').checked = c.brs !== false; linkCBrs();
    $('cExt').checked = !!c.ext;
  }
  for (const [el, k, t] of [['cFunc', 'func', 's'], ['cPad', 'pad', 's'], ['cFd', 'fd', 'b'], ['cBrs', 'brs', 'b'], ['cExt', 'ext', 'b']]) {
    $(el).addEventListener('change', () => { ctrls[curCtrl][k] = t === 'b' ? $(el).checked : $(el).value.trim(); saveCtrls(); renderResp(true); });
  }
  // 请求 / 响应 ID 合并成一个框：分隔符不挑，/ 、； , 空格 等都能分出两个 ID
  $('cPair').addEventListener('change', () => {
    const parts = $('cPair').value.split(/[\s,，;；、\/|]+/).map(s => s.trim()).filter(Boolean);
    const c = ctrls[curCtrl]; if (!c) return;
    if (parts.length >= 2) { c.req = parts[0]; c.resp = parts[1]; }
    else if (parts.length === 1) { c.req = parts[0]; }
    saveCtrls(); fillCtrlFields(); renderResp(true);
  });
  $('ctrlSel').addEventListener('change', () => { curCtrl = +$('ctrlSel').value; saveCtrls(); fillCtrlFields(); renderResp(true); });
  $('ctrlAdd').onclick = () => { const nm = prompt('输入控制器名称', '控制器 ' + (ctrls.length + 1)); if (nm === null) return; ctrls.push({ name: nm.trim() || ('控制器 ' + (ctrls.length + 1)), req: '', resp: '', func: '', pad: '00', fd: ctrls[curCtrl] ? ctrls[curCtrl].fd : true, brs: true, ext: false }); curCtrl = ctrls.length - 1; saveCtrls(); renderCtrlSel(); };
  $('ctrlDel').onclick = () => { const c = ctrls[curCtrl]; if (c && c.builtin) { alert('内置控制器不能删除（内置的安全算法等配置挂在它上面，删了就没了）。'); return; } if (ctrls.length <= 1) { alert('至少保留一个控制器'); return; } if (!confirm(`删除“${c.name}”？`)) return; ctrls.splice(curCtrl, 1); curCtrl = 0; saveCtrls(); renderCtrlSel(); };

  // ISO-TP 实时收发引擎：发帧走原始帧通道，收到的每一帧喂给它
  const diagLog = m => { $('diagOut').innerHTML = `<span class="hint">${esc(m)}</span>`; };
  S.tp = new Diag.IsoTp({ send: rawSendFrame, log: diagLog });

  function rawSendFrame(f) {
    send(Slcan.frameCmd(f));
    if (!S.fw || !S.fw.vdlink) {   // 原版固件不回显：自己记一条 Tx
      const n = f.fd ? Slcan.FD_LEN[Slcan.LEN_DLC(f.data.length)] : f.data.length;
      const data = new Uint8Array(n).fill(0xCC); data.set(f.data);
      onFrame({ kind: 'frame', tx: true, id: f.id, ext: f.ext, fd: f.fd, brs: f.brs, rtr: false, dlc: f.fd ? Slcan.LEN_DLC(n) : n, data, ts: null });
    }
  }

  // 只检查自动处理不了的情况；通道没打开不算，发的时候自动打开（ensureChan）
  function diagReady() {
    if (!S.dev) return '设备没连接：先在“录制”页点“连接设备”。';
    if (S.open ? S.openSilent : S.silent) return '现在是只听模式：到“设置”里改成“正常收发”。';
    const c = curCfg();
    if (isNaN(c.req) || isNaN(c.resp)) return '先在上面把当前控制器的请求 ID、响应 ID 填好。';
    return '';
  }
  // 发送前：设备已连上、通道没开时自动打开通道；返回空串表示可以发
  async function ensureChan(needIds = true) {
    if (!S.dev) return '设备没连接：先在“录制”页点“连接设备”。';
    if (S.open ? S.openSilent : S.silent) return '现在是只听模式：到“设置”里改成“正常收发”。';
    if (needIds) { const why = diagReady(); if (why) return why; }
    if (!S.open) {
      log('发送前自动打开通道');
      await openChannel();
      if (!S.open) return '通道没能自动打开，看“录制”页“总线状态”里的日志。';
    }
    return '';
  }
  // 发一条 UDS 请求并把结果显示出来；返回引擎结果
  async function udsReq(payload, opt = {}) {
    const why = await ensureChan(); if (why) { diagLog('发不了：' + why); log('诊断没发出去：' + why, 'bad'); updateSendHint(); return { blocked: why }; }
    const c = curCfg();
    const cfg = opt.functional ? { ...c, req: c.func } : c;
    if (opt.functional && isNaN(c.func)) { diagLog('没填功能寻址 ID'); log('诊断没发出去：没填功能寻址 ID', 'bad'); return { blocked: 1 }; }
    const r = await S.tp.request(cfg, Uint8Array.from(payload), { timeout: opt.timeout || 2500 });
    showResp(payload, r, opt);
    logUds(payload, r);
    // 进非默认会话（扩展 / 编程）成功就自动开保持在线：会话约 5 秒没请求就自己掉，
    // 手动一步步点很容易在间隙里超时（问题 1 里 27 就是这么被 7F 拒的）；回默认会话则自动关。
    if (payload[0] === 0x10 && r.data && r.data[0] === 0x50) {
      if (payload[1] === 0x01) tpStop();
      else tpStart(true);
    }
    return r;
  }
  function showResp(reqBytes, r, opt = {}) {
    const sid = reqBytes[0];
    let h = `<div class="mono" style="color:var(--blue-d)">→ ${hexs(reqBytes)}　<span class="hint">${esc(Diag.serviceName(sid))}</span></div>`;
    if (r.timeout) h += '<div class="bad">ECU 无响应（超时）。检查 ID、波特率、是否在只听模式、线是否接好。</div>';
    else if (r.error) h += '<div class="bad">出错：' + esc(r.error) + '</div>';
    else if (r.nrc !== undefined) h += `<div class="bad">否定响应 0x${hx(r.nrc)}：${esc(r.nrcText)}</div>`;
    else if (r.data) {
      h += `<div class="mono" style="color:var(--ok)">← ${hexs(r.data)}</div>`;
      if (r.data[0] === (sid | 0x40)) h += `<div class="good">正响应（${esc(Diag.serviceName(sid))} 成功）</div>`;
    }
    if (!opt.keepList) $('diagOut').innerHTML = h;
    else $('diagOut').innerHTML = h;
  }
  // 把一次 UDS 问答记进运行日志（导出分析用）。长数据只记前 24 字节；安全访问送 key 的那条不记 key。
  function logUds(reqBytes, r) {
    const cut = a => a.length > 24 ? hexs(a.slice(0, 24)) + ` …（共 ${a.length} 字节）` : hexs(a);
    const reqShown = (reqBytes[0] === 0x27 && reqBytes.length > 2 && reqBytes[1] % 2 === 0)
      ? hexs(reqBytes.slice(0, 2)) + ' …（key 不记入日志）' : cut(reqBytes);
    let line = `诊断 → ${reqShown}（${Diag.serviceName(reqBytes[0])}）`;
    if (r.timeout) line += ' ← 超时无响应';
    else if (r.error) line += ' ← 出错：' + r.error;
    else if (r.nrc !== undefined) line += ` ← 否定响应 0x${hx(r.nrc)} ${r.nrcText}`;
    else if (r.data) line += ` ← ${cut(r.data)}`;
    log(line, (r.timeout || r.error || r.nrc !== undefined) ? 'bad' : '');
  }

  // 会话 / 复位按钮
  $('diagBtns').addEventListener('click', e => {
    const b = e.target.closest('button[data-uds]'); if (!b) return;
    udsReq(parseHex(b.dataset.uds));
  });
  // 保持在线（循环 3E 80）：功能本来就有，这里只是把启停抽出来，
  // 让“手动点按钮”和“进非默认会话后自动开”共用同一套启停，机制不变。
  let tpTimer = null;
  function tpStart(auto) {
    if (tpTimer) return;
    udsReq([0x3E, 0x80]);
    tpTimer = setInterval(() => { const c = curCfg(); if (!S.open || S.openSilent) return; S.tp.request(c, Uint8Array.of(0x3E, 0x80), { timeout: 1000 }); }, 2000);
    $('btnTp').textContent = '保持在线：开'; $('btnTp').classList.add('p');
    log(auto ? '保持在线：开（进会话后自动，每 2 秒）' : '保持在线：开（每 2 秒）');
  }
  function tpStop() {
    if (!tpTimer) return;
    clearInterval(tpTimer); tpTimer = null;
    $('btnTp').textContent = '保持在线：关'; $('btnTp').classList.remove('p'); log('保持在线：关');
  }
  $('btnTp').onclick = () => {
    if (tpTimer) { tpStop(); return; }
    if (diagReady()) { udsReq([0x3E, 0x80]); return; }
    tpStart(false);
  };

  // 安全访问（算法随开屏密码内置载入，不在页面显示；等级固定 1）
  let secCode = store.get('secCode', '');
  const refreshSecSt = () => { $('secSt').textContent = secCode ? '内置算法已载入' : '未载入（请先在开屏输入密码解锁）'; };
  refreshSecSt();
  $('btnSec').onclick = async () => {
    const lvl = 1, reqSub = 1, keySub = 2;
    // 先紧跟着进扩展会话、再连着发 27（问题 1）：分开手点隔好几秒，会话早掉回默认，27 必被 7F 拒
    const ses = await udsReq([0x10, 0x03]);
    if (!ses.data || ses.data[0] !== 0x50) { $('diagOut').innerHTML += '<div class="bad">进扩展会话没成功，先不发安全访问。</div>'; return; }
    const seedR = await udsReq([0x27, reqSub]);
    if (!seedR.data || seedR.data[0] !== 0x67) return;
    const seed = seedR.data.slice(2);
    if (seed.every(b => b === 0)) { $('diagOut').innerHTML += '<div class="good">种子全 0，可能已经解锁。</div>'; return; }
    if (!secCode) { $('diagOut').innerHTML += '<div class="warn">还没载入安全算法，请先在开屏输入密码解锁。种子：' + hexs(seed) + '</div>'; return; }
    let key;
    try { key = Diag.runKeyPlugin(secCode, seed, lvl, seedR.data); }
    catch (e) { $('diagOut').innerHTML += '<div class="bad">算法出错：' + esc(e.message) + '</div>'; return; }
    if (!key || !key.length) { $('diagOut').innerHTML += '<div class="bad">算法没返回 key</div>'; return; }
    await udsReq([0x27, keySub, ...key]);
  };

  // 故障码：读 + 清，读出来对照问卷
  // 问卷来源和“离线数据”页一致：自己上传过就用上传的；否则用内置资料里那一页选的车型（没选过就全部车型一起查）
  let builtinData = null;
  function loadQn() {
    try { const j = JSON.parse(localStorage.getItem('clv_qn')); if (j && j.models) return j.models.flatMap(m => m.items || []); } catch (e) { /* ignore */ }
    if (!builtinData) return [];
    const cur = builtinData.models.find(m => m.model === localStorage.getItem('clv_model'));
    return cur ? cur.items : builtinData.models.flatMap(m => m.items || []);
  }
  $('btnReadDtc').onclick = async () => {
    const sub = parseHex($('dtcSub').value || '02 FF');
    const r = await udsReq([0x19, ...sub]);
    if (!r.data) { $('dtcBox').innerHTML = ''; return; }
    const parsed = Diag.parseDtcResp(r.data);
    if (!parsed || !parsed.list) { $('dtcBox').innerHTML = '<div class="hint">不是标准读故障码应答，原始数据见上方。</div>'; return; }
    if (!parsed.list.length) { $('dtcBox').innerHTML = '<div class="good">无故障码。</div>'; return; }
    const qn = loadQn();
    let h = `<div class="hint">共 ${parsed.list.length} 条：</div>`;
    for (const d of parsed.list) {
      const it = qn.find(x => x.d === d.code);
      h += `<div style="border-top:1px dashed var(--line);padding:6px 0">
        <div><b class="mono">${d.code}</b>　<span class="hint">状态 0x${hx(d.status)}：${esc(d.statusText)}</span></div>`;
      if (it) { h += `<div>${esc(it.desc || '')}</div>`; if (it.cause) h += `<div class="hint">可能原因：${esc(it.cause)}</div>`; if (it.fix) h += `<div class="hint">维修建议：${esc(it.fix)}</div>`; }
      else h += '<div class="hint">问卷里没查到（到“查看 → 离线数据”加载对应诊断问卷后可显示含义）。</div>';
      h += '</div>';
    }
    $('dtcBox').innerHTML = h;
  };
  $('btnClrDtc').onclick = async () => {
    if (!confirm('确定清除当前控制器的故障码？')) return;
    await udsReq([0x14, 0xFF, 0xFF, 0xFF]); $('dtcBox').innerHTML = '';
  };

  // 读 / 写 DID（两行各一个 DID，读、写可以填不同的 DID）
  $('btnReadDid').onclick = () => { try { const did = parseHex($('didReadId').value); if (did.length < 1) throw new Error('填 DID'); udsReq([0x22, ...did]); } catch (e) { diagLog(e.message); } };
  $('btnWriteDid').onclick = async () => {
    try {
      const did = parseHex($('didWriteId').value), data = parseHex($('didData').value);
      if (did.length < 1) throw new Error('填 DID');
      if (!confirm(`写 DID ${hexs(did)}：${hexs(data)}？`)) return;
      await udsReq([0x2E, ...did, ...data]);
    } catch (e) { diagLog(e.message); }
  };
  // 例程控制
  $('btnRtn').onclick = () => {
    try { const id = parseHex($('rtnId').value); if (id.length < 2) throw new Error('例程 ID 要 2 字节，如 0203'); const param = $('rtnParam').value.trim() ? parseHex($('rtnParam').value) : []; udsReq([0x31, parseInt($('rtnType').value, 16), ...id, ...param]); }
    catch (e) { diagLog(e.message); }
  };

  // ---- 常用指令（UDS 数据，经 ISO-TP 发给当前控制器） ----
  let cmds = store.get('cmds', null);
  if (!cmds) {
    const old = store.get('send', null);   // 旧版每条单独存 ID 的格式
    const strip = d => { const a = parseHex(d); return (a.length && a[0] <= 7 && a[0] === a.length - 1) ? hexs(a.slice(1)) : d; }; // 去掉旧的单帧长度前缀
    cmds = old ? old.map(r => ({ name: '', data: strip(r.data) })) : [
      { name: '进扩展会话', data: '10 03' }, { name: '读故障码', data: '19 02 FF' }, { name: '保持在线', data: '3E 80' }];
  }
  const saveCmds = () => store.set('cmds', cmds);
  function renderSend() {
    let h = '';
    cmds.forEach((r, i) => {
      h += `<div class="sendrow" data-i="${i}">
        <div class="btns"><button class="b p tx" data-a="once">发送</button></div>
        <input type="text" data-k="name" value="${esc(r.name || '')}" placeholder="名称（可不填）">
        <input type="text" class="mono" data-k="data" value="${esc(r.data)}" placeholder="UDS 数据，如 10 03">
        <div class="btns"><button class="b r" data-a="del">删除</button></div>
      </div>`;
    });
    $('sendRows').innerHTML = h || '<div class="hint">还没有指令，点“加一条”。</div>';
    updateSendHint();
  }
  $('sendRows').addEventListener('change', e => { const row = e.target.closest('.sendrow'); if (!row) return; cmds[+row.dataset.i][e.target.dataset.k] = e.target.value; saveCmds(); });
  $('sendRows').addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.target.dataset.k !== 'data') return;
    const row = e.target.closest('.sendrow'); cmds[+row.dataset.i].data = e.target.value; saveCmds();
    try { udsReq(parseHex(e.target.value)); } catch (err) { diagLog(err.message); }
  });
  $('sendRows').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    const i = +b.closest('.sendrow').dataset.i, r = cmds[i];
    if (b.dataset.a === 'once') { try { await udsReq(parseHex(r.data)); } catch (err) { diagLog('发送失败：' + err.message); } }
    else if (b.dataset.a === 'del') { if (!confirm(`删除“${r.name || r.data}”？`)) return; cmds.splice(i, 1); saveCmds(); renderSend(); }
  });
  $('btnAddSend').onclick = () => { cmds.push({ name: '', data: '' }); saveCmds(); renderSend(); const ins = document.querySelectorAll('#sendRows input[data-k=name]'); if (ins.length) ins[ins.length - 1].focus(); };
  renderSend();

  // ---------------- 刷写（阶段 3） ----------------
  // 复用诊断页的当前控制器 curCfg() 和安全算法插件 secCode；文件解析用 FlashFile，流程引擎用 Flash。
  const flashFiles = { driver: null, app: null };   // 解析后的 { type, segs }
  let flashing = false, flashStop = false;
  let flashTester = store.get('flashTester', '');    // 指纹诊断仪编号（内置，自动获取失败时兜底）

  // 指纹里的诊断仪编号（F184 后 4 字节）：优先自动获取，失败才回退内置写死值。
  //   1) 所连 USB 设备的序列号（WebUSB 能取到 serialNumber；Web Serial 取不到）
  //   2) 本机标识：浏览器特征 + 本机随机盐（第一次生成后存在本机）做 SHA-256，取前 4 字节
  //   3) secrets 里原来的写死值
  const hex4 = a => Array.from(a, b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  async function sha4(text) {
    try {
      if (typeof crypto === 'undefined' || !crypto.subtle) return null;
      const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(h).slice(0, 4));
    } catch (e) { return null; }
  }
  function serial4(serial) {
    const v = String(serial || '').trim();
    if (!v) return null;
    if (/^\d+$/.test(v)) {
      const n = Number(v);
      if (Number.isSafeInteger(n) && n > 0 && n <= 0xFFFFFFFF) return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    }
    return null;
  }
  async function autoTesterId() {
    // 1) 所连设备序列号
    const sn = S.dev && S.dev.serialNumber;
    if (sn) {
      const b = serial4(sn) || await sha4('usb|' + sn);
      if (b) return { bytes: b, source: 'USB 设备序列号 ' + sn };
    }
    // 2) 本机标识
    try {
      let salt = store.get('hostSalt', '');
      if (!salt) {
        const r = new Uint8Array(16); crypto.getRandomValues(r);
        salt = Array.from(r, x => x.toString(16).padStart(2, '0')).join('');
        store.set('hostSalt', salt);
      }
      const material = [navigator.userAgent, navigator.platform, navigator.language,
        screen.width + 'x' + screen.height, Intl.DateTimeFormat().resolvedOptions().timeZone || '', salt].join('|');
      const b = await sha4(material);
      if (b) return { bytes: b, source: '本机标识（浏览器特征 + 本机随机盐，SHA-256 取前 4 字节）' };
    } catch (e) { /* 下面回退 */ }
    // 3) 内置写死值兜底
    let b = [];
    try { b = Flash.parseHex(flashTester); } catch (e) { /* ignore */ }
    if (b.length) return { bytes: b, source: '自动获取失败，已回退内置写死值 ' + hex4(b) };
    return { bytes: [], source: '自动获取失败，也没有内置诊断仪编号' };
  }

  // 开屏密码解锁内置配置：控制器 / 安全算法 / 诊断仪编号 / 刷写流程加密放在 secrets.enc.json。
  // 加密方案：PBKDF2-SHA256 + AES-256-GCM，密码不进仓库；解锁后自动载入，页面不显示这些内容。
  const b64u = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function unlockSecrets(pin) {
    const enc = await (await fetch('secrets.enc.json', { cache: 'no-cache' })).json();
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b64u(enc.salt), iterations: enc.iter },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64u(enc.iv) }, key, b64u(enc.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }
  function applySecrets(sec) {
    if (sec.secCode) { secCode = sec.secCode; store.set('secCode', secCode); refreshSecSt(); }
    if (sec.tester) { flashTester = sec.tester; store.set('flashTester', sec.tester); }
    if (sec.flow) { $('fFlow').value = JSON.stringify(sec.flow, null, 1); store.set('flashFlow', $('fFlow').value); $('fFlowSt').textContent = '已载入内置流程'; }
    if (sec.ctrl) {
      let idx = ctrls.findIndex(c => c.name === sec.ctrl.name);
      if (idx < 0) { ctrls.push({ ...sec.ctrl, builtin: true }); idx = ctrls.length - 1; } else ctrls[idx] = { ...ctrls[idx], ...sec.ctrl, builtin: true };
      curCtrl = idx; saveCtrls(); renderCtrlSel();
    }
    flashCtrlHint();
  }

  function flowDefault() { return JSON.stringify(Flash.DEFAULT_FLOW, null, 1); }
  $('fFlow').value = store.get('flashFlow', '') || flowDefault();
  $('fFlow').addEventListener('change', () => { store.set('flashFlow', $('fFlow').value); $('fFlowSt').textContent = ''; });
  $('fFlowReset').onclick = () => { if (!confirm('恢复默认刷写流程？当前改动会丢。')) return; $('fFlow').value = flowDefault(); store.set('flashFlow', $('fFlow').value); $('fFlowSt').textContent = '已恢复默认'; };
  $('fFlowExport').onclick = () => {
    const blob = new Blob([$('fFlow').value], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'flash_flow.json';
    document.body.appendChild(a); a.click(); a.remove();
  };
  $('fFlowImport').onclick = () => $('fFlowFile').click();
  $('fFlowFile').onchange = async () => {
    const f = $('fFlowFile').files[0]; if (!f) return;
    try { const txt = await f.text(); JSON.parse(txt); $('fFlow').value = txt; store.set('flashFlow', txt); $('fFlowSt').textContent = '已导入'; }
    catch (e) { alert('导入失败（不是合法 JSON）：' + e.message); }
    $('fFlowFile').value = '';
  };

  function parseFlow() {
    let flow; try { flow = JSON.parse($('fFlow').value); } catch (e) { throw new Error('刷写流程不是合法 JSON：' + e.message); }
    if (!flow || !Array.isArray(flow.steps) || !flow.steps.length) throw new Error('刷写流程里没有 steps');
    return flow;
  }

  const fNameSpan = which => which === 'driver' ? 'fDrvName' : 'fAppName';
  const flashLoadSeq = { driver: 0, app: 0 };
  const fEmptyText = which => which === 'driver' ? '（引导驱动，可不选）' : '（应用程序）';
  async function loadFlashFile(which, file) {
    const input = $(which === 'driver' ? 'fDrv' : 'fApp');
    const span = $(fNameSpan(which));
    const seq = ++flashLoadSeq[which];              // 连续选文件时，只认最后一次
    if (!file) { flashFiles[which] = null; span.textContent = fEmptyText(which); renderFileInfo(); return; }
    flashFiles[which] = null;
    span.innerHTML = '<span class="warn"><i class="spin"></i>加载中…</span>';
    renderFileInfo();
    try {
      const text = await file.text();
      if (seq !== flashLoadSeq[which]) return;
      span.innerHTML = '<span class="warn"><i class="spin"></i>解析中…</span>';
      await new Promise(r => setTimeout(r, 20));    // 先让“解析中”显示出来，再开始解析
      if (seq !== flashLoadSeq[which]) return;
      flashFiles[which] = FlashFile.parseFile(file.name, text);   // 只收 S19 / HEX
      span.textContent = file.name;
    } catch (e) {
      if (seq !== flashLoadSeq[which]) return;
      flashFiles[which] = null; span.textContent = '格式不支持';
      alert(`${which === 'driver' ? 'Driver' : 'App'} 文件没加载：` + e.message);
      input.value = '';   // 同一个文件再选一次也能触发
    }
    renderFileInfo();
  }
  $('fDrv').onchange = () => loadFlashFile('driver', $('fDrv').files[0]);
  $('fApp').onchange = () => loadFlashFile('app', $('fApp').files[0]);

  function renderFileInfo() {
    const one = (label, r) => {
      if (!r) return '';
      const segs = r.segs.map(s => `0x${(s.addr >>> 0).toString(16).toUpperCase()}（${s.data.length} 字节）`).join('、');
      return `<div><b>${label}</b>：${r.type.toUpperCase()}，${r.segs.length} 段，共 ${FlashFile.total(r.segs)} 字节<br><span class="hint">${esc(segs)}</span></div>`;
    };
    const h = one('Driver', flashFiles.driver) + one('App', flashFiles.app);
    $('fInfo').innerHTML = h || '选文件后这里显示识别出的格式和各段地址 / 大小。';
  }

  function flashCtrlHint() {
    const c = ctrls[curCtrl] || {};
    $('fCtrl').innerHTML = `当前控制器：<b>${esc(c.name || '控制器')}</b>　请求 ${esc(c.req || '?')} / 响应 ${esc(c.resp || '?')} / 功能 ${esc(c.func || '?')}　${c.fd ? 'CAN FD' : '经典 CAN'}　安全算法：${secCode ? '已载入' : '<span class="warn">未载入</span>'}（控制器在“诊断”页选）`;
  }

  function flog(msg, cls) {
    const el = $('fLog'); const t = new Date().toTimeString().slice(0, 8);
    el.insertAdjacentHTML('beforeend', `<div class="${cls || ''}">${t} ${esc(msg)}</div>`);
    while (el.childNodes.length > 200) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }
  function renderSteps(steps, curIdx, status) {
    $('fSteps').innerHTML = steps.map((s, i) => {
      let cls = '', mark = '○';
      if (i < curIdx || (i === curIdx && status === 'ok')) { cls = 'ok'; mark = '✓'; }
      else if (i === curIdx && status === 'run') { cls = 'run'; mark = '▶'; }
      else if (i === curIdx && status === 'fail') { cls = 'fail'; mark = '✗'; }
      return `<div class="fstep ${cls}">${mark} ${esc(s.name || s.op)}</div>`;
    }).join('');
  }

  renderFileInfo(); flashCtrlHint();

  // ---------------- 开屏密码锁 ----------------
  // 打开网页先解锁：输对密码才进，内置配置（控制器 / 安全算法 / 诊断仪编号 / 刷写流程）随之自动载入。
  // 密码记在本机，下次打开自动解锁；密码不进仓库。
  async function gateUnlock(pin, silent) {
    let sec;
    try { sec = await unlockSecrets(pin); }
    catch (e) { if (!silent) $('gateErr').innerHTML = '<span class="bad">密码错误，请重试</span>'; return false; }
    applySecrets(sec);
    store.set('pin', pin);
    CanlinkData.get().then(d => { builtinData = d; }).catch(() => { /* 内置资料取不到：离线数据页自己上传也能用 */ });
    $('gate').hidden = true;
    return true;
  }
  $('gateBtn').onclick = async () => {
    const pin = $('gatePin').value.trim();
    if (!pin) { $('gateErr').textContent = '请输入密码'; return; }
    $('gateErr').textContent = '解锁中…'; $('gateBtn').disabled = true;
    const ok = await gateUnlock(pin, false);
    $('gateBtn').disabled = false;
    if (!ok) { $('gatePin').value = ''; $('gatePin').focus(); }
  };
  $('gatePin').addEventListener('keydown', e => { if (e.key === 'Enter') $('gateBtn').click(); });
  (async () => {   // 本机记住的密码：自动解锁
    const saved = store.get('pin', '');
    if (saved && await gateUnlock(saved, true)) return;
    document.documentElement.classList.remove('haspin'); // 没记住密码或记住的密码不对：这时才显示密码屏
    $('gatePin').focus();
  })();

  $('fStop').onclick = () => { flashStop = true; $('fStop').textContent = '正在停止…'; };
  $('fStart').onclick = async () => {
    if (flashing) return;
    const why = await ensureChan();
    if (why) { alert('还不能刷写：' + why); return; }
    let flow;
    try { flow = parseFlow(); } catch (e) { alert(e.message); return; }
    if (!flashFiles.driver && !flashFiles.app) { alert('先选 Driver 或 App 文件'); return; }
    const needFp = flow.steps.some(s => s.op === 'fingerprint');
    const testerInfo = await autoTesterId();
    const tester = testerInfo.bytes;
    if (needFp && !tester.length) { if (!confirm('没有可用的诊断仪编号（自动获取失败，也没载入内置值），将用全 0 写指纹，继续？')) return; }
    if (!confirm('确认开始刷写？\n请先确认电压 / 充电宝接好、手机不锁屏，中途别拔线。')) return;

    flashing = true; flashStop = false;
    $('fStart').disabled = true; $('fStop').hidden = false; $('fStop').textContent = '停止';
    $('fLog').innerHTML = ''; $('fBar').style.width = '0'; $('fProg').textContent = '0%';
    log(`开始刷写：${curCfg().name}（${[flashFiles.driver ? 'Driver：' + $('fDrvName').textContent : '', flashFiles.app ? 'App：' + $('fAppName').textContent : ''].filter(Boolean).join('；')}）`);
    if (needFp) flog('指纹编号来源：' + testerInfo.source);
    renderSteps(flow.steps, -1, '');
    try {
      const r = await Flash.runFlash({
        tp: S.tp, cfg: curCfg(), flow, files: flashFiles, keyPlugin: secCode, tester, Diag,
        hooks: {
          log: flog,
          shouldStop: () => flashStop,
          onStep: (i, total, s, st, msg) => { if (st === 'fail') { renderSteps(flow.steps, lastRunIdx, 'fail'); } else { if (st === 'run') lastRunIdx = i; renderSteps(flow.steps, i, st); } },
          onProgress: (frac, text) => { $('fBar').style.width = (Math.max(0, Math.min(1, frac)) * 100).toFixed(1) + '%'; $('fProg').textContent = text || ''; },
        },
      });
      if (r.ok) { $('fBar').style.width = '100%'; $('fProg').innerHTML = '<span class="good">刷写完成 100%</span>'; log('刷写完成'); }
      else { $('fProg').innerHTML = '<span class="bad">刷写失败：' + esc(r.error || '') + '</span>'; log('刷写失败：' + (r.error || ''), 'bad'); }
    } catch (e) { flog('出错：' + e.message, 'bad'); $('fProg').innerHTML = '<span class="bad">出错：' + esc(e.message) + '</span>'; log('刷写出错：' + e.message, 'bad'); }
    finally { flashing = false; $('fStart').disabled = false; $('fStop').hidden = true; }
  };
  let lastRunIdx = -1;

  // ---- 手动发送原始帧（不走 ISO-TP，用于非诊断报文 / 循环发送） ----
  // BRS 与 CANFD 联动：经典 CAN 没有 BRS，BRS 开关只在 CANFD 时可用（默认开）。
  const SC = Object.assign({ id: '7DF', resp: '', cyc: 100, ext: false, fd: false, brs: true }, store.get('sendCfg', {}));
  const cyclic = new Map();
  for (const [el, k] of Object.entries({ sId: 'id', sResp: 'resp', sCyc: 'cyc', sExt: 'ext', sFd: 'fd', sBrs: 'brs' })) {
    const x = $(el); if (x.type === 'checkbox') x.checked = !!SC[k]; else x.value = SC[k];
    x.addEventListener('change', () => { SC[k] = x.type === 'checkbox' ? x.checked : x.value; store.set('sendCfg', SC); });
  }
  function linkSBrs() { const b = $('sBrs'); b.disabled = !$('sFd').checked; b.closest('label').classList.toggle('off', b.disabled); }
  $('sFd').addEventListener('change', linkSBrs); linkSBrs();
  function buildFrame(dataText) {
    const id = parseId(SC.id); if (isNaN(id)) throw new Error('发送 ID 不对');
    const data = parseHex(dataText);
    return { id, ext: !!SC.ext || id > 0x7FF, fd: !!SC.fd, brs: !!SC.fd && SC.brs !== false, data };
  }
  function logSend(f, cycMs) {
    log(`${cycMs ? `循环发送（每 ${cycMs} ms）` : '发送'} → ${hx(f.id, f.ext ? 8 : 3)}${f.ext ? 'x' : ''} ${f.fd ? 'FD' : 'CAN'} ${hexs(f.data)}`);
  }
  async function sendData(dataText) {
    const f = buildFrame(dataText);
    const why = await ensureChan(false); if (why) throw new Error(why);
    rawSendFrame(f);
    return f;
  }
  $('btnRawSend').onclick = () => {
    const v = $('rawData').value;
    if (cyclic.has('raw')) { clearInterval(cyclic.get('raw')); cyclic.delete('raw'); $('btnRawSend').textContent = '发送'; log('已停止循环发送'); return; }
    const ms = +SC.cyc;
    if (ms && ms >= 1 && /\S/.test(v)) {
      try { buildFrame(v); } catch (e) { diagLog(e.message); return; }
      cyclic.set('raw', setInterval(() => sendData(v).catch(err => { clearInterval(cyclic.get('raw')); cyclic.delete('raw'); $('btnRawSend').textContent = '发送'; diagLog('循环停止：' + err.message); log('循环发送停止：' + err.message, 'bad'); }), ms));
      $('btnRawSend').textContent = '停止循环';
      logSend(buildFrame(v), ms);
    } else sendData(v).then(f => logSend(f)).catch(err => { diagLog('发送失败：' + err.message); log('发送失败：' + err.message, 'bad'); });
  };
  function stopCyclic() { for (const t of cyclic.values()) clearInterval(t); cyclic.clear(); const b = $('btnRawSend'); if (b) b.textContent = '发送'; }

  function updateSendHint() {
    const why = diagReady();
    const raw = !S.dev ? '设备没连接：先在“录制”页点“连接设备”。' : (S.open ? S.openSilent : S.silent) ? '现在是只听模式：到“设置”里改成“正常收发”。' : '';
    $('sendHint').innerHTML = raw ? '<span class="warn">' + raw + '</span>' : (S.open ? '可以发送。' : '可以发送（通道没开时发送会自动打开）。');
    for (const b of document.querySelectorAll('#sendRows button.tx')) b.disabled = !!why;
  }

  // 最近收发：当前控制器的请求 ID 和响应 ID（含功能寻址）
  function respIds() {
    const c = curCfg(); const rs = [];
    if (!isNaN(c.resp)) rs.push(c.resp);
    if (c.func === 0x7DF) for (let i = 0x7E8; i <= 0x7EF; i++) rs.push(i);
    return rs;
  }
  let respRender = 0;
  function renderResp(force) {
    if (!$('send').classList.contains('on')) return;
    const now = performance.now();
    if (!force && now - respRender < 300) return;
    respRender = now;
    const c = curCfg(), rs = respIds();
    const list = S.recent.filter(m => (m.tx && m.id === c.req) || (!m.tx && rs.includes(m.id))).slice(-30);
    $('respInfo').textContent = !isNaN(c.req) ? `（发送 ${hx(c.req, 3)}，回复 ${rs.map(x => hx(x, 3)).join('/') || '—'}）` : '';
    let h = '<table><thead><tr><th>时间 s</th><th>ID</th><th>数据</th></tr></thead><tbody>';
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      h += `<tr class="${m.tx ? 'tx' : ''}"><td>${m.t.toFixed(3)}</td><td>${m.tx ? '→' : '←'}${idText(m.id, m.ext)}</td><td class="d">${hexs(m.data)}</td></tr>`;
    }
    $('respBox').innerHTML = list.length ? h + '</tbody></table>' : '<div class="hint">还没有收发。</div>';
  }
  renderCtrlSel();
  setInterval(() => renderResp(false), 300);

  // ---------------- 录制 ----------------
  function startRec() {
    S.rec = new Recorder();
    updateMarks();   // 新录制从零开始：清掉上一段的标记列表与范围选项，别等停录才刷新
    $('recName').value = '';   // 文件名也一并重置，上一段填的名字别带进新录制
    S.recording = true;
    S.recT0 = S.lastT;
    S.saved = false;
    $('btnRec').textContent = '停止录制'; $('btnRec').classList.add('r'); $('btnRec').classList.remove('p');
    $('btnMark').disabled = false; $('chipRec').classList.add('show');
    $('btnSave').disabled = true; $('btnShare').disabled = true; $('btnView').disabled = true;
    log('开始录制');
  }
  function stopRec() {
    S.recording = false;
    if (S.rec) S.rec.seal();
    $('btnRec').textContent = '开始录制'; $('btnRec').classList.remove('r'); $('btnRec').classList.add('p');
    $('btnMark').disabled = true; $('chipRec').classList.remove('show');
    $('btnSave').disabled = !S.rec || !S.rec.count; $('btnShare').disabled = !S.rec || !S.rec.count;
    $('btnView').disabled = !S.rec || !S.rec.count;
    updateMarks();
    if (S.rec) log(`录制停止：${S.rec.count} 帧`);
  }
  // 开始录制时通道没开：先连上设备、打开通道（打开通道本身会按设置自动开始录制）
  $('btnRec').onclick = async () => {
    if (S.recording) { stopRec(); return; }
    if (!S.dev) { log('先连接设备', 'bad'); $('devInfo').innerHTML = '<span class="warn">还没连接设备：先点“连接设备”。</span>'; return; }
    if (!S.open) await openChannel();
    if (S.open && !S.recording) startRec();
  };
  $('btnMark').onclick = () => {
    if (!S.recording) return;
    const t = Math.max(0, (S.lastT || 0) - S.recT0);
    S.rec.mark(t);
    log(`标记 ${S.rec.marks.length}：${t.toFixed(3)} s`);
    updateMarks();
    updateRecInfo();
  };
  const fmtDur = s => { s = Math.floor(s); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  function updateRecInfo() {
    if (!S.rec) return;
    const dur = S.recording ? Math.max(0, S.lastT - S.recT0) : S.rec.t1Last();
    $('rDur').textContent = fmtDur(dur);
    $('rCnt').textContent = S.rec.count.toLocaleString();
    const has = S.rec.count > 0 && !S.recording;  // 录制中下载 / 分享 / 查看都置灰
    $('btnSave').disabled = !has; $('btnView').disabled = !has; $('btnShare').disabled = !has;
    $('btnMarks').disabled = !(has && S.rec.marks.length);
    $('rMarks').textContent = S.rec.marks.length ? S.rec.marks.length + ' 处' : '无';   // 只报有几处；每个标记的时间在下面备注列表里有
  }
  function updateMarks() {
    const opts = ['<option value="start">开头</option>'];
    if (S.rec) S.rec.marks.forEach((m, i) => opts.push(`<option value="${i}">标记 ${i + 1}（${m.t.toFixed(1)}s）</option>`));
    opts.push('<option value="end">结尾</option>');
    $('mFrom').innerHTML = opts.join(''); $('mTo').innerHTML = opts.join('');
    $('mTo').value = 'end';
    renderMarkList();
  }
  // 标记备注编辑：标签即备注，进 BLF 标记文字与 ASC 注释；留空则用默认 Mark N。
  function renderMarkList() {
    const box = $('markList');
    if (!S.rec || !S.rec.marks.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="hint" style="margin-top:8px">标记备注（下载前可改）：</div>' +
      S.rec.marks.map((m, i) => {
        const def = `Mark ${i + 1}`, custom = m.label && m.label !== def;
        return `<div class="mkrow"><span class="mkt">标记 ${i + 1} · ${m.t.toFixed(3)}s</span>` +
          `<input type="text" data-mk="${i}" value="${custom ? esc(m.label) : ''}" placeholder="${def}（点此填备注）"></div>`;
      }).join('');
    box.querySelectorAll('input[data-mk]').forEach(inp => inp.addEventListener('change', () => {
      const i = +inp.dataset.mk, v = inp.value.trim();
      if (S.rec && S.rec.marks[i]) S.rec.marks[i].label = v || `Mark ${i + 1}`;
    }));
  }
  function marksFileName() { return fileName().replace(/\.(asc|blf)$/i, '') + '_marks.txt'; }
  function marksListText() {
    const d = S.rec.startDate, p = v => String(v).padStart(2, '0');
    const ds = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    const base = fileName().replace(/\.(asc|blf)$/i, '');
    const lines = ['canlink 标记清单', `录制开始：${ds}`, `数据文件：${base}.blf / .asc`, `共 ${S.rec.marks.length} 个标记`, ''];
    S.rec.marks.forEach((m, i) => lines.push(`${i + 1}. ${m.t.toFixed(3)}s — ${m.label}`));
    lines.push('', '在 CANalyzer 里按 ID 1FFFFFF0 过滤可逐个跳到标记帧，序号与本清单一致。');
    return lines.join('\n') + '\n';
  }
  // 通用导出弹窗：预览内容 + 下载 / 分享（标记清单、导出设置、导出日志共用）
  let dlgFile = null;
  function openFileDlg(title, file, text) {
    dlgFile = file;
    $('fileTitle').textContent = title;
    $('fileName').textContent = `${file.name}（${file.size < 1024 ? file.size + ' B' : (file.size / 1024).toFixed(1) + ' KB'}）`;
    $('fileText').hidden = text == null;
    $('fileText').textContent = text == null ? '' : text;
    $('fileMsg').textContent = '';
    $('fileModal').hidden = false;
  }
  $('btnFileClose').onclick = () => { $('fileModal').hidden = true; };
  $('fileModal').addEventListener('click', e => { if (e.target === $('fileModal')) $('fileModal').hidden = true; });
  $('btnFileDl').onclick = () => { if (dlgFile) { downloadFile(dlgFile); log(`已下载 ${dlgFile.name}`); } };
  $('btnFileShare').onclick = async () => {
    const f = dlgFile; if (!f) return;
    if (shareBlockedByBrowser(f)) { downloadFile(f); $('fileMsg').textContent = '这个浏览器不能直接分享这类文件，已改为下载。'; log(`当前浏览器不允许分享这类文件，已改为下载：${f.name}`); return; }
    let can = false;
    try { can = !!navigator.share && (!navigator.canShare || navigator.canShare({ files: [f] })); } catch (e) { can = false; }
    if (!can) { downloadFile(f); $('fileMsg').textContent = '这个浏览器不能直接分享文件，已改为下载。'; log(`不能分享，已改为下载 ${f.name}`); return; }
    try { await navigator.share({ files: [f], title: f.name }); log(`已分享 ${f.name}`); }
    catch (e) { if (e.name !== 'AbortError') { downloadFile(f); $('fileMsg').textContent = '分享没有成功，已改为下载。'; } }
  };
  $('btnMarks').onclick = () => {
    if (!S.rec || !S.rec.marks.length) return;
    const text = marksListText();
    openFileDlg('标记清单', new File([text], marksFileName(), { type: 'text/plain' }), text);
  };
  $('range').onchange = () => {
    const v = $('range').value;
    $('fMarks').hidden = v !== 'marks'; $('fLast').hidden = v !== 'last'; $('fCustom').hidden = v !== 'custom';
    $('rangeRow').hidden = v === 'all';
  };
  function saveRange() {
    const end = S.rec.t1Last(), v = $('range').value;
    const markT = x => x === 'start' ? 0 : x === 'end' ? end : S.rec.marks[+x].t;
    if (v === 'marks') { const a = markT($('mFrom').value), b = markT($('mTo').value); return [Math.min(a, b), Math.max(a, b)]; }
    if (v === 'last') return [Math.max(0, end - +$('lastSec').value), end];
    if (v === 'custom') return [+$('cFrom').value, +$('cTo').value];
    return [0, end];
  }
  function fileName() {
    const fmt = $('recFmt') ? $('recFmt').value : 'blf';
    const n = $('recName').value.trim().replace(/[\\/:*?"<>|\s]+/g, '_');
    const d = S.rec.startDate, p = v => String(v).padStart(2, '0');
    const def = `can_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    return (n || def).replace(/\.(asc|blf)$/i, '') + '.' + fmt;
  }
  async function makeFile() {
    const [a, b] = saveRange();
    const fmt = $('recFmt') ? $('recFmt').value : 'blf';
    if (fmt === 'blf') {
      const blob = await S.rec.toBLF(a, b);
      return new File([blob], fileName(), { type: 'application/octet-stream' });
    }
    const blob = await S.rec.toASC(a, b, { comment: `vdlink CAN tool, ${S.nominal / 1000}k${S.fdOn ? ' / ' + S.data / 1e6 + 'M FD' : ''}${S.silent ? ', listen-only' : ''}` });
    return new File([blob], fileName(), { type: 'text/plain' });
  }

  // Chromium（安卓/桌面 Chrome、Edge）分享文件有类型白名单，只放行图片/音视频/PDF/文本；
  // 且它的 canShare 不查文件类型、会假报 true，要等 share() 才以 NotAllowedError 拒绝。
  // .blf/.asc 必然被拒，不如一开始就说明原因并改下载；iOS Safari 不受此限（其 canShare 是准的）。
  function shareBlockedByBrowser(f) {
    if (!/Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent || '')) return false;
    const ext = ((f.name.match(/\.([a-z0-9]+)$/i) || [])[1] || '').toLowerCase();
    const ok = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp3', 'wav', 'ogg', 'flac', 'm4a', 'mp4', 'webm', 'mov', 'pdf', 'txt', 'csv', 'html', 'htm'];
    return !ok.includes(ext);
  }
  function downloadFile(f) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f); a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  $('btnSave').onclick = async () => {
    const f = await makeFile();
    downloadFile(f);
    S.saved = true;
    log(`已保存 ${f.name}（${(f.size / 1048576).toFixed(1)} MB）`);
  };
  $('btnView').onclick = async () => {
    if (!S.rec || !S.rec.count) return;
    if (!await needClosed()) return;
    if (S.recording) stopRec();
    const f = await makeFile();
    document.querySelector('#tabs button[data-t=trace]').click();
    await setTraceMode('offline', f);
    log(`在离线数据里打开 ${f.name}`);
  };
  $('btnShare').onclick = async () => {
    if (!S.rec || !S.rec.count) return;
    let f;
    try { f = await makeFile(); }
    catch (e) { alert('生成录制文件失败：' + e.message); return; }
    if (shareBlockedByBrowser(f)) {
      downloadFile(f); S.saved = true;
      log(`当前浏览器不允许分享这类文件，已改为下载：${f.name}`, 'bad');
      alert('这个浏览器只允许网页分享图片、视频、PDF、文本几类文件，.blf/.asc 分享不出去（浏览器限制）。已改为下载，下载后可以在文件管理里长按该文件、再分享到微信等应用。');
      return;
    }
    let can = false;
    try { can = !!navigator.share && (!navigator.canShare || navigator.canShare({ files: [f] })); } catch (e) { can = false; }
    if (!can) {
      // 安卓 UC / 微信、电脑浏览器等不支持分享文件：别让按钮点了没反应，直接改成下载。
      downloadFile(f); S.saved = true;
      log(`这个浏览器不能直接分享文件，已改为下载：${f.name}`, 'bad');
      alert('这个浏览器不能直接分享文件，已改为下载。');
      return;
    }
    try { await navigator.share({ files: [f], title: f.name }); }
    catch (e) {
      if (e.name === 'AbortError') return;           // 用户自己取消，不算错
      downloadFile(f); S.saved = true;
      log(`分享失败（${e.message}），已改为下载：${f.name}`, 'bad');
      alert('分享没有成功，已改为下载：' + e.message);
    }
  };
  updateMarks();

  // ---------------- 刷固件 ----------------
  $('btnFlash').onclick = async () => {
    if (!navigator.usb) { $('fwMsg').innerHTML = '<span class="bad">这个浏览器不支持 WebUSB。</span>'; return; }
    if (S.dev) await disconnect();
    const bar = $('fwBar'), msg = $('fwMsg');
    const dfu = new Dfu.StmDfu(t => { msg.textContent = t; });
    try {
      const bin = await (await fetch('fw/vdlink-1.0.bin', { cache: 'no-cache' })).arrayBuffer();
      await dfu.open();
      await dfu.flash(bin, (p, t) => { bar.style.width = (p * 100).toFixed(0) + '%'; msg.textContent = t; });
      msg.innerHTML = '<span class="good">完成。拔下板子、取下 BOOT 跳线帽，再插上就是 vdlink 固件。</span>';
    } catch (e) {
      if (e && e.name === 'NotFoundError') { msg.textContent = '没有选设备。确认 BOOT 跳线帽已插上、重新插了 USB。'; return; }
      msg.innerHTML = `<span class="bad">失败：${esc(e.message || e)}</span>`;
    } finally {
      await dfu.close();
    }
  };

  // ---------------- 导出 / 导入设置 ----------------
  $('btnExport').onclick = () => {
    const out = {};
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('canlink.')) out[k.slice(8)] = JSON.parse(localStorage.getItem(k)); } } catch (e) { /* ignore */ }
    const text = JSON.stringify({ app: 'vdlink-can-tool', version: 1, data: out }, null, 1);
    // 预览里不显示保密项（安全算法、诊断仪编号、刷写流程、开屏密码等），文件里照常保存，导入后能还原
    const hide = ['pin', 'secCode', 'flashFlow', 'flashTester', 'hostSalt'];
    const shown = {};
    for (const [k, v] of Object.entries(out)) shown[k] = hide.includes(k) ? '（保密，预览不显示）' : v;
    const preview = JSON.stringify({ app: 'vdlink-can-tool', version: 1, data: shown }, null, 1);
    openFileDlg('导出设置和常用指令', new File([text], 'can_tool_settings.json', { type: 'application/json' }), preview);
  };
  $('btnLog').onclick = () => {
    const p = v => String(v).padStart(2, '0');
    const now = new Date();
    const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
    const head = [
      'canlink 运行日志',
      `导出时间：${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`,
      `页面：${location.href}`,
      `浏览器：${navigator.userAgent}`,
      `屏幕：${screen.width}×${screen.height}`,
      `WebUSB：${navigator.usb ? '支持' : '不支持'}；Web Serial：${navigator.serial ? '支持' : '不支持'}`,
      `通道设置：标称 ${S.nominal / 1000}k，CANFD ${S.fdOn ? `开（数据段 ${S.data / 1e6}M）` : '关'}，只听 ${S.silent ? '开' : '关'}`,
      `日志条数：${LOG_LINES.length}`,
      '----',
    ];
    const text = head.join('\n') + '\n' + LOG_LINES.join('\n') + '\n';
    openFileDlg('导出日志', new File([text], `canlink-log-${stamp}.txt`, { type: 'text/plain' }), text);
  };
  $('btnImport').onclick = () => $('importFile').click();
  $('importFile').onchange = async () => {
    const f = $('importFile').files[0]; if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (!j || j.app !== 'vdlink-can-tool' || !j.data) throw new Error('不是本工具导出的文件');
      for (const [k, v] of Object.entries(j.data)) store.set(k, v);
      alert('已导入，页面会重新加载。');
      location.reload();
    } catch (e) { alert('导入失败：' + e.message); }
  };
  // 离线缓存：打开过一次后，没网 / GitHub 打不开也能用
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(() => {
      $('offlineInfo').textContent = '离线可用：已存到本机，没网时也能打开。可以在浏览器菜单里“添加到主屏幕 / 安装应用”，像 APP 一样从桌面打开。';
    }).catch(() => { $('offlineInfo').textContent = '离线缓存没开成（浏览器不支持或在无痕模式）。'; });
  }
  // 请浏览器尽量不要自动清掉本站数据
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* ignore */ }

  const lastTab = store.get('tab', 'rec');
  const tabBtn = document.querySelector(`#tabs button[data-t="${lastTab}"]`);
  if (tabBtn) tabBtn.click();

  updateButtons();
  updateTiming();
  window.addEventListener('beforeunload', e => { if (S.rec && S.rec.count && (S.recording || !S.saved)) { e.preventDefault(); e.returnValue = ''; } });
  window.CanApp = S; // 调试用
})();
