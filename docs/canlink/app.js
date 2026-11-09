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

  function log(msg, cls) {
    const el = $('log');
    const t = new Date().toTimeString().slice(0, 8);
    el.insertAdjacentHTML('beforeend', `<div class="${cls || ''}">${t} ${esc(msg)}</div>`);
    while (el.childNodes.length > 60) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }

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
  S.silent = store.get('cfg.silent', true);
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
    $('devInfo').innerHTML = `已连接：<b>${esc(t.name)}</b>，固件：${fwText}`;
    $('fwNow').innerHTML = `当前：${esc(t.name)}，${fwText}`;
    log(`已连接 ${t.name}，固件 ${S.fw.vdlink ? 'vdlink ' + S.fw.version : S.fw.version}`);
    updateButtons();
    updateTiming();
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

  $('btnConn').onclick = () => S.dev ? disconnect() : connect(false);
  $('btnDemo').onclick = () => { connect(true); document.querySelector('#tabs button[data-t=rec]').click(); };
  if (!Transport.pick()) showNoApi();

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
    $('tmodeHint').textContent = mode === 'offline' ? '打开 blf / asc 文件，或在“录制”页点“查看”。DBC、诊断问卷在下面加载。' : '';
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
  if (!ctrls || !ctrls.length) ctrls = [{ name: '控制器 1', req: '7E0', resp: '7E8', func: '7DF', pad: '00', fd: false, brs: true, ext: false }];
  let curCtrl = Math.min(store.get('ctrlCur', 0), ctrls.length - 1);
  const saveCtrls = () => { store.set('ctrls', ctrls); store.set('ctrlCur', curCtrl); };
  function curCfg() {
    const c = ctrls[curCtrl] || {};
    const pad = String(c.pad || '').trim();
    return { req: parseId(c.req), resp: parseId(c.resp), func: c.func ? parseId(c.func) : null,
      fd: !!c.fd, brs: c.brs !== false, ext: !!c.ext, pad: pad ? parseId(pad) & 0xFF : 0 };
  }
  function renderCtrlSel() {
    $('ctrlSel').innerHTML = ctrls.map((c, i) => `<option value="${i}"${i === curCtrl ? ' selected' : ''}>${esc(c.name || ('控制器 ' + (i + 1)))}</option>`).join('');
    fillCtrlFields();
  }
  function fillCtrlFields() {
    const c = ctrls[curCtrl] || {};
    $('cName').value = c.name || ''; $('cReq').value = c.req || ''; $('cResp').value = c.resp || '';
    $('cFunc').value = c.func || ''; $('cPad').value = c.pad || ''; $('cFd').checked = !!c.fd;
    $('cBrs').checked = c.brs !== false; $('cExt').checked = !!c.ext;
  }
  for (const [el, k, t] of [['cName', 'name', 's'], ['cReq', 'req', 's'], ['cResp', 'resp', 's'], ['cFunc', 'func', 's'], ['cPad', 'pad', 's'], ['cFd', 'fd', 'b'], ['cBrs', 'brs', 'b'], ['cExt', 'ext', 'b']]) {
    $(el).addEventListener('change', () => { ctrls[curCtrl][k] = t === 'b' ? $(el).checked : $(el).value.trim(); saveCtrls(); if (el === 'cName') renderCtrlSel(); renderResp(true); });
  }
  $('ctrlSel').addEventListener('change', () => { curCtrl = +$('ctrlSel').value; saveCtrls(); fillCtrlFields(); renderResp(true); });
  $('ctrlAdd').onclick = () => { ctrls.push({ name: '控制器 ' + (ctrls.length + 1), req: '', resp: '', func: '', pad: '00', fd: ctrls[curCtrl] ? ctrls[curCtrl].fd : false, brs: true, ext: false }); curCtrl = ctrls.length - 1; saveCtrls(); renderCtrlSel(); };
  $('ctrlDel').onclick = () => { if (ctrls.length <= 1) { alert('至少保留一个控制器'); return; } if (!confirm(`删除“${ctrls[curCtrl].name}”？`)) return; ctrls.splice(curCtrl, 1); curCtrl = 0; saveCtrls(); renderCtrlSel(); };
  $('ctrlExport').onclick = () => {
    const blob = new Blob([JSON.stringify({ app: 'vdlink-ctrls', version: 1, ctrls }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'can_controllers.json';
    document.body.appendChild(a); a.click(); a.remove();
  };
  $('ctrlImport').onclick = () => $('ctrlFile').click();
  $('ctrlFile').onchange = async () => {
    const f = $('ctrlFile').files[0]; if (!f) return;
    try { const j = JSON.parse(await f.text()); const arr = Array.isArray(j) ? j : j.ctrls; if (!Array.isArray(arr) || !arr.length) throw new Error('文件里没有控制器'); ctrls = arr; curCtrl = 0; saveCtrls(); renderCtrlSel(); alert(`已导入 ${arr.length} 个控制器`); }
    catch (e) { alert('导入失败：' + e.message); }
    $('ctrlFile').value = '';
  };

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

  function diagReady() {
    if (!S.dev) return '先在“录制”页连接设备。';
    if (!S.open) return '通道没打开：到“录制”页点“打开通道”。';
    if (S.openSilent) return '现在是只听模式：到“设置”里改成“正常收发”。';
    const c = curCfg();
    if (isNaN(c.req) || isNaN(c.resp)) return '先在上面把当前控制器的请求 ID、响应 ID 填好。';
    return '';
  }
  // 发一条 UDS 请求并把结果显示出来；返回引擎结果
  async function udsReq(payload, opt = {}) {
    const why = diagReady(); if (why) { diagLog('发不了：' + why); updateSendHint(); return { blocked: why }; }
    const c = curCfg();
    const cfg = opt.functional ? { ...c, req: c.func } : c;
    if (opt.functional && isNaN(c.func)) { diagLog('没填功能寻址 ID'); return { blocked: 1 }; }
    const r = await S.tp.request(cfg, Uint8Array.from(payload), { timeout: opt.timeout || 2500 });
    showResp(payload, r, opt);
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

  // 会话 / 复位按钮
  $('diagBtns').addEventListener('click', e => {
    const b = e.target.closest('button[data-uds]'); if (!b) return;
    udsReq(parseHex(b.dataset.uds));
  });
  // 保持在线（循环 3E 80）
  let tpTimer = null;
  $('btnTp').onclick = () => {
    if (tpTimer) { clearInterval(tpTimer); tpTimer = null; $('btnTp').textContent = '保持在线：关'; $('btnTp').classList.remove('p'); return; }
    if (diagReady()) { udsReq([0x3E, 0x80]); return; }
    udsReq([0x3E, 0x80]);
    tpTimer = setInterval(() => { const c = curCfg(); if (!S.open || S.openSilent) return; S.tp.request(c, Uint8Array.of(0x3E, 0x80), { timeout: 1000 }); }, 2000);
    $('btnTp').textContent = '保持在线：开（每 2 秒）'; $('btnTp').classList.add('p');
  };

  // 安全访问
  let secCode = store.get('secCode', '');
  $('secCode').value = secCode;
  $('secSt').textContent = secCode ? '已加载算法' : '未加载算法';
  $('btnSecEdit').onclick = () => { $('secBox').hidden = !$('secBox').hidden; };
  $('secSave').onclick = () => { secCode = $('secCode').value; store.set('secCode', secCode); $('secSt').textContent = secCode ? '已保存' : '已清空'; };
  $('secClear').onclick = () => { secCode = ''; $('secCode').value = ''; store.set('secCode', ''); $('secSt').textContent = '已清空'; };
  $('btnSec').onclick = async () => {
    const lvl = Math.max(1, +$('secLevel').value || 1);
    const reqSub = 2 * lvl - 1, keySub = 2 * lvl;
    const seedR = await udsReq([0x27, reqSub]);
    if (!seedR.data || seedR.data[0] !== 0x67) return;
    const seed = seedR.data.slice(2);
    if (seed.every(b => b === 0)) { $('diagOut').innerHTML += '<div class="good">种子全 0，可能已经解锁。</div>'; return; }
    if (!secCode) { $('diagOut').innerHTML += '<div class="warn">拿到种子了，但还没加载安全算法。点“算法插件…”把算法贴进去。种子：' + hexs(seed) + '</div>'; return; }
    let key;
    try { key = Diag.runKeyPlugin(secCode, seed, lvl, seedR.data); }
    catch (e) { $('diagOut').innerHTML += '<div class="bad">算法出错：' + esc(e.message) + '</div>'; return; }
    if (!key || !key.length) { $('diagOut').innerHTML += '<div class="bad">算法没返回 key</div>'; return; }
    await udsReq([0x27, keySub, ...key]);
  };

  // 故障码：读 + 清，读出来对照问卷
  function loadQn() {
    try { const j = JSON.parse(localStorage.getItem('clv_qn')); if (j && j.models) return j.models.flatMap(m => m.items || []); } catch (e) { /* ignore */ }
    return [];
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

  // 读 / 写 DID
  $('btnReadDid').onclick = () => { try { const did = parseHex($('didId').value); if (did.length < 1) throw new Error('填 DID'); udsReq([0x22, ...did]); } catch (e) { diagLog(e.message); } };
  $('btnWriteDid').onclick = async () => {
    try {
      const did = parseHex($('didId').value), data = parseHex($('didData').value);
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
        <input type="text" data-k="name" value="${esc(r.name || '')}" placeholder="名称（可不填）">
        <input type="text" class="mono" data-k="data" value="${esc(r.data)}" placeholder="UDS 数据，如 10 03">
        <div class="btns">
          <button class="b p tx" data-a="once">发送</button>
          <button class="b r" data-a="del">删除</button>
        </div></div>`;
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

  $('fTester').value = store.get('flashTester', '');
  $('fTester').addEventListener('change', () => store.set('flashTester', $('fTester').value));

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

  async function loadFlashFile(which, file) {
    if (!file) { flashFiles[which] = null; renderFileInfo(); return; }
    try {
      const nameLow = file.name.toLowerCase();
      let res;
      if (/\.(bin)$/.test(nameLow)) {
        const addr = parseInt(String($('fBinAddr').value).trim().replace(/^0x/i, ''), 16);
        if (isNaN(addr)) throw new Error('选了 .bin，请先在下面填起始地址（十六进制）');
        res = FlashFile.parse(new Uint8Array(await file.arrayBuffer()), undefined, addr);
      } else {
        res = FlashFile.parse(await file.text());
      }
      flashFiles[which] = res;
    } catch (e) { flashFiles[which] = null; alert(`${which === 'driver' ? 'Driver' : 'App'} 解析失败：` + e.message); }
    renderFileInfo();
  }
  $('fDrv').onchange = () => loadFlashFile('driver', $('fDrv').files[0]);
  $('fApp').onchange = () => loadFlashFile('app', $('fApp').files[0]);
  $('fBinAddr').addEventListener('change', () => { if ($('fDrv').files[0] && /\.bin$/i.test($('fDrv').files[0].name)) loadFlashFile('driver', $('fDrv').files[0]); if ($('fApp').files[0] && /\.bin$/i.test($('fApp').files[0].name)) loadFlashFile('app', $('fApp').files[0]); });

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
    $('fCtrl').innerHTML = `当前控制器：<b>${esc(c.name || '控制器')}</b>　请求 ${esc(c.req || '?')} / 响应 ${esc(c.resp || '?')} / 功能 ${esc(c.func || '?')}　${c.fd ? 'CAN FD' : '经典 CAN'}　安全算法：${secCode ? '已加载' : '<span class="warn">未加载</span>'}（都在“诊断”页改）`;
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

  $('fStop').onclick = () => { flashStop = true; $('fStop').textContent = '正在停止…'; };
  $('fStart').onclick = async () => {
    if (flashing) return;
    const why = diagReady();
    if (why) { alert('还不能刷写：' + why); return; }
    let flow;
    try { flow = parseFlow(); } catch (e) { alert(e.message); return; }
    if (!flashFiles.driver && !flashFiles.app) { alert('先选 Driver 或 App 文件'); return; }
    const needFp = flow.steps.some(s => s.op === 'fingerprint');
    let tester = [];
    try { tester = Flash.parseHex($('fTester').value); } catch (e) { /* ignore，下面判断 */ }
    if (needFp && !tester.length) { if (!confirm('没填指纹诊断仪编号，将用全 0 写指纹，继续？')) return; }
    if (!confirm('确认开始刷写？\n请先确认电压 / 充电宝接好、手机不锁屏，中途别拔线。')) return;

    flashing = true; flashStop = false;
    $('fStart').disabled = true; $('fStop').hidden = false; $('fStop').textContent = '停止';
    $('fLog').innerHTML = ''; $('fBar').style.width = '0'; $('fProg').textContent = '';
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
      if (r.ok) { $('fBar').style.width = '100%'; $('fProg').innerHTML = '<span class="good">刷写完成</span>'; }
      else { $('fProg').innerHTML = '<span class="bad">刷写失败：' + esc(r.error || '') + '</span>'; }
    } catch (e) { flog('出错：' + e.message, 'bad'); $('fProg').innerHTML = '<span class="bad">出错：' + esc(e.message) + '</span>'; }
    finally { flashing = false; $('fStart').disabled = false; $('fStop').hidden = true; }
  };
  let lastRunIdx = -1;

  // ---- 手动发送原始帧（不走 ISO-TP，用于非诊断报文 / 循环发送） ----
  const SC = Object.assign({ id: '7DF', resp: '', cyc: 100, ext: false, fd: false, brs: false }, store.get('sendCfg', {}));
  const cyclic = new Map();
  for (const [el, k] of Object.entries({ sId: 'id', sResp: 'resp', sCyc: 'cyc', sExt: 'ext', sFd: 'fd', sBrs: 'brs' })) {
    const x = $(el); if (x.type === 'checkbox') x.checked = !!SC[k]; else x.value = SC[k];
    x.addEventListener('change', () => { SC[k] = x.type === 'checkbox' ? x.checked : x.value; store.set('sendCfg', SC); });
  }
  function buildFrame(dataText) {
    const id = parseId(SC.id); if (isNaN(id)) throw new Error('发送 ID 不对');
    const data = parseHex(dataText);
    return { id, ext: !!SC.ext || id > 0x7FF, fd: !!SC.fd, brs: !!SC.fd && !!SC.brs, data };
  }
  async function sendData(dataText) {
    if (!S.open || S.openSilent) throw new Error('通道没打开，或者是只听模式');
    rawSendFrame(buildFrame(dataText));
  }
  $('btnRawSend').onclick = () => {
    const v = $('rawData').value;
    if (cyclic.has('raw')) { clearInterval(cyclic.get('raw')); cyclic.delete('raw'); $('btnRawSend').textContent = '发送'; return; }
    const ms = +SC.cyc;
    if (ms && ms >= 1 && /\S/.test(v)) {
      try { buildFrame(v); } catch (e) { diagLog(e.message); return; }
      cyclic.set('raw', setInterval(() => sendData(v).catch(err => { clearInterval(cyclic.get('raw')); cyclic.delete('raw'); $('btnRawSend').textContent = '发送'; diagLog('循环停止：' + err.message); }), ms));
      $('btnRawSend').textContent = '停止循环';
    } else sendData(v).catch(err => diagLog('发送失败：' + err.message));
  };
  function stopCyclic() { for (const t of cyclic.values()) clearInterval(t); cyclic.clear(); const b = $('btnRawSend'); if (b) b.textContent = '发送'; }

  function updateSendHint() {
    const why = diagReady();
    $('diagHint').innerHTML = why ? '<span class="warn">' + why + '</span>' : '<span class="good">可以诊断。</span>';
    $('sendHint').innerHTML = why ? '<span class="warn">' + why + '</span>' : '可以发送。';
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
    S.recording = true;
    S.recT0 = S.lastT;
    S.saved = false;
    $('btnRec').textContent = '停止录制'; $('btnRec').classList.add('r'); $('btnRec').classList.remove('p');
    $('btnMark').disabled = false; $('chipRec').hidden = false;
    $('btnSave').disabled = true; $('btnShare').disabled = true; $('btnView').disabled = true;
    log('开始录制');
  }
  function stopRec() {
    S.recording = false;
    if (S.rec) S.rec.seal();
    $('btnRec').textContent = '开始录制'; $('btnRec').classList.remove('r'); $('btnRec').classList.add('p');
    $('btnMark').disabled = true; $('chipRec').hidden = true;
    $('btnSave').disabled = !S.rec || !S.rec.count; $('btnShare').disabled = !S.rec || !S.rec.count || !navigator.share;
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
    updateRecInfo();
  };
  const fmtDur = s => { s = Math.floor(s); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  function updateRecInfo() {
    if (!S.rec) return;
    const dur = S.recording ? Math.max(0, S.lastT - S.recT0) : S.rec.t1Last();
    $('rDur').textContent = fmtDur(dur);
    $('rCnt').textContent = S.rec.count.toLocaleString();
    const has = S.rec.count > 0 && !S.recording;  // 录制中下载 / 分享 / 查看都置灰
    $('btnSave').disabled = !has; $('btnView').disabled = !has; $('btnShare').disabled = !has || !navigator.share;
    $('rMarks').textContent = S.rec.marks.length ? S.rec.marks.map(m => m.t.toFixed(1) + 's').join('，') : '无';
  }
  function updateMarks() {
    const opts = ['<option value="start">开头</option>'];
    if (S.rec) S.rec.marks.forEach((m, i) => opts.push(`<option value="${i}">标记 ${i + 1}（${m.t.toFixed(1)}s）</option>`));
    opts.push('<option value="end">结尾</option>');
    $('mFrom').innerHTML = opts.join(''); $('mTo').innerHTML = opts.join('');
    $('mTo').value = 'end';
  }
  $('range').onchange = () => {
    const v = $('range').value;
    $('fMarks').hidden = v !== 'marks'; $('fLast').hidden = v !== 'last'; $('fCustom').hidden = v !== 'custom';
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
    const n = $('recName').value.trim().replace(/[\\/:*?"<>|\s]+/g, '_');
    const d = S.rec.startDate, p = v => String(v).padStart(2, '0');
    const def = `can_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    return (n || def).replace(/\.asc$/i, '') + '.asc';
  }
  async function makeFile() {
    const [a, b] = saveRange();
        const blob = await S.rec.toASC(a, b, { comment: `vdlink CAN tool, ${S.nominal / 1000}k${S.fdOn ? ' / ' + S.data / 1e6 + 'M FD' : ''}${S.silent ? ', listen-only' : ''}` });
    return new File([blob], fileName(), { type: 'text/plain' });
  }
  $('btnSave').onclick = async () => {
    const f = await makeFile();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f); a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
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
    try {
      const f = await makeFile();
      if (navigator.canShare && !navigator.canShare({ files: [f] })) throw new Error('这个浏览器不能分享文件，请用“下载”');
      await navigator.share({ files: [f], title: f.name });
    } catch (e) { if (e.name !== 'AbortError') log('分享失败：' + e.message, 'bad'); }
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
    const blob = new Blob([JSON.stringify({ app: 'vdlink-can-tool', version: 1, data: out }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'can_tool_settings.json';
    document.body.appendChild(a); a.click(); a.remove();
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
