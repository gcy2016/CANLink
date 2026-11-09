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
    clock: new Slcan.Clock(), hostT0: 0, lastT: 0, ppm: 0, clockLocked: false,
    ids: new Map(), scroll: [], paused: false, view: 'fixed', filter: null,
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
    if (b.dataset.t === 'trace') renderTrace(true);
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
  const cfgIds = ['nomRate', 'nomSp', 'fdOn', 'dataRate', 'dataSp', 'niso', 'recAuto'];
  for (const id of cfgIds) {
    const el = $(id), v = store.get('cfg.' + id, null);
    if (v !== null) { if (el.type === 'checkbox') el.checked = v; else el.value = v; }
    el.addEventListener('change', () => { store.set('cfg.' + id, el.type === 'checkbox' ? el.checked : el.value); updateTiming(); });
  }
  S.silent = store.get('cfg.silent', true);
  setSeg('mode', S.silent ? 1 : 0);
  seg('mode', v => { S.silent = v === '1'; store.set('cfg.silent', S.silent); updateSendHint(); });

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

  async function connect(demo) {
    if (S.dev) await disconnect();
    let t;
    if (demo) t = new DemoTransport();
    else {
      t = Transport.pick();
      if (!t) { $('noApi').hidden = false; return; }
    }
    t.onData = text => reader.push(text);
    t.onClose = () => { log('设备断开了', 'bad'); cleanup(); };
    try {
      await t.open();
    } catch (e) {
      if (e && e.name === 'NotFoundError') return; // 用户取消了选择
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
    $('chipDev').textContent = t.name;
    $('chipDev').classList.add('on');
    $('devInfo').innerHTML = `已连接：<b>${esc(t.name)}</b>，固件：${S.fw.vdlink ? 'vdlink ' + esc(S.fw.version) : '<span class="warn">' + esc(S.fw.version) + '（原版，建议到“固件”页刷 vdlink）</span>'}`;
    $('fwNow').innerHTML = $('devInfo').innerHTML;
    log(`已连接 ${t.name}，固件 ${S.fw.vdlink ? 'vdlink ' + S.fw.version : S.fw.version}`);
    $('btnOpen').disabled = false; $('btnDisconnect').disabled = false;
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
    S.dev = null; S.open = false; S.fw = null;
    clearInterval(S.statusTimer); S.statusTimer = null;
    releaseWake();
    $('chipDev').textContent = '未连接'; $('chipDev').classList.remove('on');
    setBusChip();
    $('btnOpen').disabled = true; $('btnClose').disabled = true; $('btnDisconnect').disabled = true;
    $('devInfo').textContent = '未连接'; $('fwNow').textContent = '当前：未连接';
    updateSendHint();
  }

  $('btnConnect').onclick = () => connect(false);
  $('btnDemo').onclick = () => connect(true);
  $('btnDisconnect').onclick = () => disconnect();
  if (!Transport.pick()) $('noApi').hidden = false;

  // ---------------- 通道 ----------------
  async function openChannel() {
    if (!S.dev || S.open) return;
    const { nom, dat, fd } = timings();
    if (!nom || (fd && !dat)) { log('波特率凑不出来，换一个采样点或波特率试试', 'bad'); return; }
    S.fdOn = fd; S.nominal = nom.bitrate; S.data = fd ? dat.bitrate : 0;
    S.configuring = true;
    try { if (!await configure(nom, dat, fd)) return; } finally { S.configuring = false; }
    S.clock.reset(); S.clock.ppm = S.ppm;
    S.hostT0 = performance.now(); S.lastT = 0;
    resetStats();
    await send('O');
    S.open = true;
    setBusChip();
    $('btnOpen').disabled = true; $('btnClose').disabled = false;
    log(`通道已打开：${nom.bitrate / 1000}k${fd ? ' / ' + dat.bitrate / 1e6 + 'M FD' : ''}，${S.silent ? '只听' : '正常收发'}`);
    updateSendHint();
    requestWake();
    if ($('recAuto').checked && !S.recording) startRec();
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

  async function closeChannel() {
    if (!S.open) return;
    stopCyclic();
    await send('C');
    S.open = false;
    setBusChip();
    $('btnOpen').disabled = !S.dev; $('btnClose').disabled = true;
    log('通道已关闭');
    updateSendHint();
    releaseWake();
  }
  $('btnOpen').onclick = openChannel;
  $('btnClose').onclick = closeChannel;

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
    if (m.ts !== null && S.fw && S.fw.vdlink) return S.clock.seconds(m.ts);
    return (performance.now() - S.hostT0) / 1000;
  }

  function onFrame(m) {
    const t = frameTime(m);
    S.lastT = t;
    m.t = t;
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
    if (!$('trace').classList.contains('on')) return;
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

  // ---------------- 发送 ----------------
  let sendRows = store.get('send', [{ id: '7DF', ext: false, fd: false, brs: false, data: '02 10 03', cyc: 100 }]);
  const cyclic = new Map();
  function updateSendHint() {
    const ok = S.open && !S.silent;
    $('sendHint').innerHTML = ok ? '可以发送。' : '<span class="warn">要先在“连接”页把模式切到“正常收发”，再打开通道。</span>';
    for (const b of document.querySelectorAll('#sendRows button.tx')) b.disabled = !ok;
  }
  function renderSend() {
    let h = '';
    sendRows.forEach((r, i) => {
      h += `<div class="sendrow" data-i="${i}">
        <div class="fld">ID（十六进制）<input type="text" class="mono" data-k="id" value="${esc(r.id)}" style="width:110px"></div>
        <div class="fld">数据（十六进制，空格隔开）<input type="text" class="mono" data-k="data" value="${esc(r.data)}"></div>
        <div class="row full">
          <label><input type="checkbox" data-k="ext" ${r.ext ? 'checked' : ''}> 扩展帧</label>
          <label><input type="checkbox" data-k="fd" ${r.fd ? 'checked' : ''}> FD</label>
          <label><input type="checkbox" data-k="brs" ${r.brs ? 'checked' : ''}> BRS</label>
          <label>周期 <input type="number" data-k="cyc" value="${r.cyc || 100}" min="1" style="width:80px"> ms</label>
        </div>
        <div class="row full">
          <button class="b p tx" data-a="once">发送一次</button>
          <button class="b tx" data-a="cyc">${cyclic.has(i) ? '停止循环' : '循环发送'}</button>
          <button class="b r" data-a="del">删除</button>
        </div></div>`;
    });
    $('sendRows').innerHTML = h;
    updateSendHint();
  }
  $('sendRows').addEventListener('change', e => {
    const row = e.target.closest('.sendrow'); if (!row) return;
    const r = sendRows[+row.dataset.i], k = e.target.dataset.k;
    r[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    store.set('send', sendRows);
  });
  function buildFrame(r) {
    const id = parseInt(String(r.id).replace(/^0x/i, ''), 16);
    if (isNaN(id)) throw new Error('ID 不对');
    const hex = String(r.data).replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
    if (hex.length % 2) throw new Error('数据要按字节写（两位十六进制一个字节）');
    const data = new Uint8Array(hex.length / 2);
    for (let i = 0; i < data.length; i++) data[i] = parseInt(hex.substr(i * 2, 2), 16);
    return { id, ext: !!r.ext || id > 0x7FF, fd: !!r.fd, brs: !!r.fd && !!r.brs, data };
  }
  async function sendRow(r) {
    if (!S.open || S.silent) throw new Error('通道没打开，或者是只听模式');
    const f = buildFrame(r);
    await send(Slcan.frameCmd(f));
    // 原版固件不回显发送的报文：自己记一条（时间用本机时间）
    if (!S.fw.vdlink) {
      const n = f.fd ? Slcan.FD_LEN[Slcan.LEN_DLC(f.data.length)] : f.data.length;
      const data = new Uint8Array(n).fill(0xCC); data.set(f.data);
      onFrame({ kind: 'frame', tx: true, id: f.id, ext: f.ext, fd: f.fd, brs: f.brs, rtr: false, dlc: f.fd ? Slcan.LEN_DLC(n) : n, data, ts: null });
    }
  }
  $('sendRows').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    const i = +b.closest('.sendrow').dataset.i, r = sendRows[i];
    try {
      if (b.dataset.a === 'once') await sendRow(r);
      else if (b.dataset.a === 'del') { stopCyclic(i); sendRows.splice(i, 1); store.set('send', sendRows); stopCyclic(); renderSend(); }
      else if (b.dataset.a === 'cyc') {
        if (cyclic.has(i)) stopCyclic(i);
        else {
          buildFrame(r);
          const ms = Math.max(1, +r.cyc || 100);
          cyclic.set(i, setInterval(() => sendRow(r).catch(err => { stopCyclic(i); log('循环发送停止：' + err.message, 'bad'); }), ms));
        }
        renderSend();
      }
    } catch (err) { log('发送失败：' + err.message, 'bad'); }
  });
  function stopCyclic(i) {
    if (i === undefined) { for (const t of cyclic.values()) clearInterval(t); cyclic.clear(); }
    else { clearInterval(cyclic.get(i)); cyclic.delete(i); }
    if ($('sendRows').childNodes.length) for (const b of document.querySelectorAll('#sendRows button[data-a=cyc]')) {
      const k = +b.closest('.sendrow').dataset.i; b.textContent = cyclic.has(k) ? '停止循环' : '循环发送';
    }
  }
  $('btnAddSend').onclick = () => { sendRows.push({ id: '123', ext: false, fd: false, brs: false, data: '00 00 00 00 00 00 00 00', cyc: 100 }); store.set('send', sendRows); renderSend(); };
  renderSend();

  // ---------------- 录制 ----------------
  function startRec() {
    S.rec = new Recorder();
    S.recording = true;
    S.recT0 = S.lastT;
    S.saved = false;
    $('btnRec').textContent = '停止录制'; $('btnRec').classList.add('r'); $('btnRec').classList.remove('p');
    $('btnMark').disabled = false; $('chipRec').hidden = false;
    $('btnSave').disabled = true; $('btnShare').disabled = true;
    log('开始录制');
  }
  function stopRec() {
    S.recording = false;
    if (S.rec) S.rec.seal();
    $('btnRec').textContent = '开始录制'; $('btnRec').classList.remove('r'); $('btnRec').classList.add('p');
    $('btnMark').disabled = true; $('chipRec').hidden = true;
    $('btnSave').disabled = !S.rec || !S.rec.count; $('btnShare').disabled = !S.rec || !S.rec.count || !navigator.share;
    updateMarks();
    if (S.rec) log(`录制停止：${S.rec.count} 帧`);
  }
  $('btnRec').onclick = () => { if (S.recording) stopRec(); else startRec(); };
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

  updateTiming();
  window.addEventListener('beforeunload', e => { if (S.rec && S.rec.count && (S.recording || !S.saved)) { e.preventDefault(); e.returnValue = ''; } });
  window.CanApp = S; // 调试用
})();
