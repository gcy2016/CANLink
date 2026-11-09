// AI 助手：使用者自己填写 API Key，浏览器直接调用所选大模型（OpenAI 兼容接口 / Claude 原生接口）。
// Key 与设置只存在本机浏览器 localStorage；提问时附带由网页按固定规则整理的当前数据（文字，可先查看修改）。
const AI = (() => {
  const PRESETS = [
    { id: 'claude', name: 'Claude（Anthropic）', proto: 'anthropic', url: 'https://api.anthropic.com/v1/messages', model: 'claude-opus-5-5' },
    { id: 'deepseek', name: 'DeepSeek', proto: 'openai', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { id: 'qwen', name: '通义千问（阿里云百炼）', proto: 'openai', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    { id: 'kimi', name: 'Kimi（月之暗面）', proto: 'openai', url: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k' },
    { id: 'glm', name: '智谱 GLM', proto: 'openai', url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    { id: 'doubao', name: '豆包（火山方舟）', proto: 'openai', url: 'https://ark.cn-beijing.volces.com/api/v3', model: '' },
    { id: 'openai', name: 'OpenAI', proto: 'openai', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { id: 'custom', name: '其他（OpenAI 兼容接口）', proto: 'openai', url: '', model: '' },
  ];
  // 支持服务端安全回退（refusal 时自动换模型）的 Claude 模型
  const FALLBACK_MODELS = ['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5'];
  const SYSTEM = '你是资深的汽车电子电气与售后诊断工程师，熟悉 CAN / CAN FD 总线、UDS 诊断（ISO 14229）、ISO-TP 和各类整车控制器。' +
    '用户会给你网页从报文中整理出的数据（故障码、诊断过程、信号变化、报文内容，部分页面只有原始报文的十六进制数据）以及诊断问卷里的解释，并提出问题。' +
    '请结合这些数据和汽车诊断通用知识回答：先给结论，再按可能性从高到低列出可能原因，然后给出具体可操作的排查步骤和注意事项。' +
    '数据不足以下结论时直接说明还需要什么数据或测量，不要编造数据里没有的数值。用中文回答，条理清晰、简洁。';
  const KEY = 'ai_cfg';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch (e) { return null; } };
  const store = c => { try { if (c) localStorage.setItem(KEY, JSON.stringify(c)); else localStorage.removeItem(KEY); } catch (e) {} };

  // ---------- 数据整理（纯规则，不调用模型） ----------
  const num = v => Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6)));
  const lower = (t, x) => { let lo = 0, hi = t.length; while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m; } return lo; };

  function sigText(s, x0, x1) {
    const a = lower(s.t, x0), b = lower(s.t, x1 + 1e-9);
    const head = `- ${s.name}${s.unit ? ` [${s.unit}]` : ''}（报文 ${s.msg}）`;
    if (b <= a) return head + '：该时间段内无数据';
    const txt = k => (s.vt && s.raw && s.vt[s.raw[k]] !== undefined ? `(${s.vt[s.raw[k]]})` : '');
    if (s.step) {                                     // 状态类：列出每次变化
      const ch = [a];
      for (let k = a + 1; k < b; k++) if (s.v[k] !== s.v[k - 1]) ch.push(k);
      const list = ch.slice(0, 25).map(k => `${s.t[k].toFixed(3)}s=${num(s.v[k])}${txt(k)}`).join('；');
      return `${head}：${ch.length > 1 ? `共变化 ${ch.length - 1} 次：` : '始终为 '}${list}${ch.length > 25 ? '；…' : ''}`;
    }
    let mn = a, mx = a, sum = 0;
    for (let k = a; k < b; k++) { if (s.v[k] < s.v[mn]) mn = k; if (s.v[k] > s.v[mx]) mx = k; sum += s.v[k]; }
    const n = b - a, step = Math.max(1, Math.floor(n / 10)), pts = [];
    for (let k = a; k < b; k += step) pts.push(`${s.t[k].toFixed(2)}s:${num(s.v[k])}`);
    return `${head}：${n} 个采样点，最小 ${num(s.v[mn])}（${s.t[mn].toFixed(3)}s），最大 ${num(s.v[mx])}（${s.t[mx].toFixed(3)}s），` +
      `平均 ${num(sum / n)}，首 ${num(s.v[a])}，末 ${num(s.v[b - 1])}\n  采样：${pts.slice(0, 12).join('，')}`;
  }

  // st: {view, model, dtcItem, dtcQuery, log, logName, dbc, dtcs, events, sigs, win, trace}
  function summarize(st) {
    const L = [];
    if (st.model) L.push(`车型 / 问卷：${st.model}`);
    if (st.view === 'dtc') {
      const it = st.dtcItem;
      if (it) {
        L.push(`查询的故障码：${it.d}（高中字节 ${it.hm}，低字节 ${it.l}）`);
        L.push(`问卷故障描述：${it.desc || '（未填写）'}`, `问卷可能原因：${it.cause || '（未填写）'}`, `问卷维修建议：${it.fix || '（未填写）'}`);
      } else if (st.dtcQuery) L.push(`查询的故障码：${st.dtcQuery}（问卷中没有找到）`);
      return L.join('\n');
    }
    if (!st.log) { L.push('（尚未打开报文）'); return L.join('\n'); }
    L.push(`报文文件：${st.logName}，时长 ${st.log.dur.toFixed(2)} s，${st.log.n} 帧` + (st.dbc === undefined ? '' : `；DBC：${st.dbc ? st.dbc.name : '未加载'}`));
    if (st.dtcs === undefined) {
      // 页面不做故障码识别（如纯报文查看版）
    } else if (st.dtcs.length) {
      L.push('', '【识别到的故障码】');
      for (const d of st.dtcs) {
        L.push(`- ${d.code}（${d.b}）来自 ${d.ecu}，${d.src}，状态 0x${d.st.toString(16).toUpperCase().padStart(2, '0')}${d.statusText ? ' ' + d.statusText : ''}，` +
          `首次 ${d.t.toFixed(3)}s${d.n > 1 ? `，共 ${d.n} 次` : ''}`);
        if (d.it) L.push(`  问卷：${d.it.desc || ''}；可能原因：${d.it.cause || ''}；维修建议：${d.it.fix || ''}`);
      }
    } else L.push('', '【识别到的故障码】无（报文中没有读码应答，也没有广播的故障码信号）');
    if (st.events && st.events.length) {
      L.push('', '【诊断过程】');
      for (const e of st.events.slice(0, 30)) L.push(`- ${e.t.toFixed(3)}s ${e.ecu} ${e.text}`);
    }
    if (st.sigs && st.sigs.length) {
      const [x0, x1] = st.win;
      L.push('', `【信号曲线】时间窗口 ${x0.toFixed(3)}–${x1.toFixed(3)} s`);
      for (const s of st.sigs) L.push(sigText(s, x0, x1));
    }
    if (st.trace) L.push('', '【选中的报文】', st.trace);
    if (st.frames) L.push('', st.frames);
    let out = L.join('\n');
    if (out.length > 15000) out = out.slice(0, 15000) + '\n…（数据过长，已截断）';
    return out;
  }

  // ---------- 调用模型（流式） ----------
  async function* sse(resp) {
    const rd = resp.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
  }

  async function chat(cfg, messages, onText) {
    let resp;
    try {
      if (cfg.proto === 'anthropic') {
        const body = { model: cfg.model, max_tokens: 16000, stream: true, system: SYSTEM, messages };
        const headers = { 'content-type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true' };
        if (FALLBACK_MODELS.includes(cfg.model)) { body.fallbacks = 'default'; headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; }
        resp = await fetch(cfg.url, { method: 'POST', headers, body: JSON.stringify(body) });
      } else {
        const url = /\/chat\/completions\/?$/.test(cfg.url) ? cfg.url : cfg.url.replace(/\/+$/, '') + '/chat/completions';
        resp = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.key },
          body: JSON.stringify({ model: cfg.model, stream: true, messages: [{ role: 'system', content: SYSTEM }, ...messages] }) });
      }
    } catch (e) {
      throw new Error('无法连接到接口（网络不通，或该厂商不允许网页直接调用 / 跨域被拦截）。请检查接口地址；如仍不行，需要通过中转服务调用。');
    }
    if (!resp.ok) {
      let msg = '';
      try { const j = await resp.json(); msg = (j.error && (j.error.message || j.error.type)) || j.message || JSON.stringify(j); } catch (e) {}
      const hint = resp.status === 401 || resp.status === 403 ? '（API Key 不正确或没有权限）' : resp.status === 404 ? '（接口地址或模型名不正确）' :
        resp.status === 429 ? '（请求太频繁或额度不足）' : resp.status === 402 ? '（账户余额不足）' : '';
      throw new Error(`接口返回错误 ${resp.status}${hint}${msg ? '：' + msg : ''}`);
    }
    let all = '', stop = '';
    for await (const d of sse(resp)) {
      if (d === '[DONE]') break;
      let j; try { j = JSON.parse(d); } catch (e) { continue; }
      let t = '';
      if (cfg.proto === 'anthropic') {
        if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') t = j.delta.text;
        else if (j.type === 'message_delta' && j.delta) stop = j.delta.stop_reason || stop;
        else if (j.type === 'error') throw new Error('模型返回错误：' + ((j.error && j.error.message) || '未知错误'));
      } else {
        const c = j.choices && j.choices[0];
        t = (c && c.delta && c.delta.content) || '';
        if (j.error) throw new Error('模型返回错误：' + (j.error.message || JSON.stringify(j.error)));
      }
      if (t) { all += t; onText(all); }
    }
    if (stop === 'refusal') { all += (all ? '\n\n' : '') + '（模型拒绝回答该问题）'; onText(all); }
    if (stop === 'max_tokens') { all += '\n\n（回答过长被截断）'; onText(all); }
    return all;
  }

  // 极简 Markdown：标题 / 粗体 / 列表 / 代码
  function md(s) {
    return esc(s).replace(/```([\s\S]*?)```/g, (_, c) => `<pre>${c.replace(/^\w*\n/, '')}</pre>`)
      .replace(/^#{1,6}\s*(.+)$/gm, '<b class="h">$1</b>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');
  }

  const CSS = `
  .ai .bar2 { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
  .ai .bar2 .sp { flex: 1; }
  .ai [data-a="close"] { display: none; }
  /* 全屏模式：点输入框 / 聊天内容后铺满屏幕，“✕ 收起”回到原页面 */
  .ai.full { position: fixed; inset: 0; z-index: 1000; background: var(--card, #fff); padding: 12px 14px calc(12px + env(safe-area-inset-bottom));
    display: flex; flex-direction: column; overflow: hidden; }
  .ai.full [data-a="close"] { display: inline-block; }
  .ai.full .msgs { flex: 1; overflow-y: auto; min-height: 0; -webkit-overflow-scrolling: touch; }
  .ai.full .in textarea { min-height: 72px; max-height: 32vh; }
  .ai.full .note[data-f="tip"] { display: none; }
  .ai.full details.ctx textarea { height: 26vh; }
  .ai.full .cfg { max-height: 50vh; overflow-y: auto; }
  /* 手机：输入框字号不小于 16px，否则 iOS 点进输入框会自动放大整个页面，之后页面能左右拖动 */
  @media (max-width: 899px) { .ai textarea, .ai input, .ai select { font-size: 16px !important; } }
  /* 电脑上：居中大窗口，背后变暗；手机上仍铺满屏幕 */
  @media (min-width: 900px) {
    .ai.full { inset: 4vh auto; left: 50%; transform: translateX(-50%); width: min(960px, 92vw); border-radius: 16px;
      padding: 16px 20px; box-shadow: 0 0 0 100vmax rgba(15,23,42,.45), 0 12px 40px rgba(0,0,0,.25); }
    .ai.full .m { max-width: 80%; }
  }
  .ai-modal { position: fixed; inset: 0; z-index: 1003; background: rgba(15,23,42,.45); display: grid; place-items: center; padding: 16px; }
  .ai-modal .box { background: #fff; border-radius: 16px; padding: 18px 18px 14px; max-width: 340px; width: 100%; font-size: 15px; line-height: 1.6; }
  .ai-modal .box b { font-size: 17px; }
  .ai-modal .box p { color: var(--muted, #6b7280); font-size: 13.5px; margin: 8px 0 14px; }
  .ai-modal .row { display: flex; gap: 10px; justify-content: flex-end; }
  .ai-modal button { min-width: 84px; height: 38px; font-size: 15px; border-radius: 10px; cursor: pointer; }
  .ai-modal button.b { border: 1.5px solid var(--line, #d5dde8); background: #fff; color: var(--blue-d, #22507f); }
  .ai-modal button.p { border: 0; background: var(--blue, #2a6db5); color: #fff; }
  .ai-modal textarea.mc { width: 100%; height: 40vh; font: 13px/1.5 ui-monospace, Menlo, Consolas, monospace; border: 1.5px solid var(--line, #d5dde8); border-radius: 10px; padding: 8px; margin-bottom: 12px; }
  @media (max-width: 899px) { .ai-modal textarea.mc { font-size: 16px; } }
  .ai .toast { position: fixed; left: 50%; top: 64px; transform: translateX(-50%); background: rgba(31,41,55,.92); color: #fff; padding: 8px 16px; border-radius: 999px; font-size: 14px; z-index: 1001; }
  .ai button.b { border: 1.5px solid var(--line); background: #fff; border-radius: 8px; padding: 5px 10px; font-size: 14px; cursor: pointer; color: var(--blue-d); }
  .ai button.p { border: 0; background: var(--blue); color: #fff; border-radius: 10px; padding: 0 16px; font-size: 15px; cursor: pointer; }
  .ai button:disabled { opacity: .5; cursor: default; }
  .ai .cfg { background: #f8fafc; border: 1px solid var(--line); border-radius: 12px; padding: 12px; margin-bottom: 12px; font-size: 14px; }
  .ai .cfg label { display: block; margin: 6px 0 2px; color: var(--muted); font-size: 13px; }
  .ai .cfg input, .ai .cfg select { width: 100%; font-size: 14px; padding: 7px 10px; border: 1.5px solid var(--line); border-radius: 8px; background: #fff; }
  .ai .cfg .row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .ai .note { color: var(--muted); font-size: 12.5px; margin-top: 8px; line-height: 1.6; }
  .ai details.ctx { margin-bottom: 10px; font-size: 14px; }
  .ai details.ctx summary { cursor: pointer; color: var(--blue); }
  .ai details.ctx textarea { width: 100%; height: 220px; margin-top: 6px; font: 12.5px/1.5 ui-monospace, Menlo, Consolas, monospace; border: 1.5px solid var(--line); border-radius: 10px; padding: 8px; }
  .ai .msgs { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
  .ai .m { border-radius: 12px; padding: 8px 12px; font-size: 15px; line-height: 1.7; max-width: 92%; word-break: break-word; }
  .ai .m.u { align-self: flex-end; background: var(--blue); color: #fff; white-space: pre-wrap; }
  .ai .m.a { align-self: flex-start; background: #f3f6fa; }
  .ai .m.a b.h { display: block; margin-top: 4px; color: var(--blue-d); }
  .ai .m.a pre { background: #fff; padding: 6px 8px; border-radius: 8px; overflow: auto; font-size: 12.5px; }
  .ai .m.e { align-self: stretch; background: #fdecea; color: #a52714; font-size: 14px; }
  .ai .in { display: flex; gap: 8px; }
  .ai .in textarea { flex: 1; min-width: 0; min-height: 44px; max-height: 160px; font-size: 15px; padding: 9px 12px; border: 1.5px solid var(--line); border-radius: 12px; outline: none; resize: vertical; font-family: inherit; }
  .ai .in textarea:focus { border-color: var(--blue); }`;

  // box：容器；getState()：返回 summarize 所需的当前状态
  function mount(box, getState) {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    box.classList.add('ai');
    box.innerHTML = `
      <div class="bar2"><button class="b" data-a="close">✕ 收起</button><span class="sp"></span><button class="b" data-a="new">新对话</button><button class="b" data-a="cfg">⚙️ 设置</button></div>
      <div class="cfg" hidden>
        <label>模型厂商</label><select data-f="preset">${PRESETS.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
        <label>接口地址</label><input data-f="url" spellcheck="false" autocomplete="off">
        <label>模型名</label><input data-f="model" spellcheck="false" autocomplete="off" placeholder="以厂商文档为准，如 deepseek-chat">
        <label>API Key</label><input data-f="key" type="password" spellcheck="false" autocomplete="off" placeholder="在厂商开放平台创建">
        <div class="row"><button class="p" data-a="save">保存</button><button class="b" data-a="del">清除 Key</button></div>
        <div class="note">Key 只保存在这台设备的浏览器里，不会上传到本网站；提问时由浏览器直接发给所选厂商，按你的账户计费。
          提问会把下方“附带的数据”（故障码、信号变化等文字）一并发给厂商。个别厂商不允许网页直接调用，会提示无法连接，需要通过中转服务调用。</div>
      </div>
      <details class="ctx"><summary>附带的数据（发送前可查看、修改）</summary>
        <div style="margin:6px 0"><label style="font-size:13px"><input type="checkbox" data-f="use" checked> 提问时附带当前数据</label>
        <button class="b" data-a="ref" style="margin-left:8px">按当前页面重新整理</button></div>
        <textarea data-f="ctx" spellcheck="false"></textarea>
      </details>
      <div class="msgs"></div>
      <div class="in"><textarea data-f="q" placeholder="输入问题，Enter 发送，Shift+Enter 换行"></textarea>
        <button class="p" data-a="send">发送</button></div>
      <div class="note" data-f="tip"></div>`;
    const $f = n => box.querySelector(`[data-f="${n}"]`), $a = n => box.querySelector(`[data-a="${n}"]`);
    const cfgBox = box.querySelector('.cfg'), msgs = box.querySelector('.msgs');
    let cfg = load(), hist = [], sentCtx = '', ctxDirty = false, busy = false;

    const fillCfg = () => {
      const p = PRESETS.find(x => x.id === (cfg && cfg.preset)) || PRESETS[0];
      $f('preset').value = p.id;
      $f('url').value = cfg ? cfg.url : p.url; $f('model').value = cfg ? cfg.model : p.model; $f('key').value = cfg ? cfg.key : '';
    };
    const tip = () => { $f('tip').textContent = cfg && cfg.key ? `当前：${(PRESETS.find(x => x.id === cfg.preset) || {}).name || ''} · ${cfg.model}` : '还没有设置 API Key：点“⚙️ 设置”填写；没有 Key 也可以用报文列表下的“📋 复制给 AI 助手”，粘贴到其他 AI 里使用。'; };
    $f('preset').onchange = () => { const p = PRESETS.find(x => x.id === $f('preset').value); $f('url').value = p.url; $f('model').value = p.model; };
    $a('cfg').onclick = () => { cfgBox.hidden = !cfgBox.hidden; if (!cfgBox.hidden) fillCfg(); };
    $a('save').onclick = () => {
      const p = PRESETS.find(x => x.id === $f('preset').value);
      const c = { preset: p.id, proto: p.proto, url: $f('url').value.trim(), model: $f('model').value.trim(), key: $f('key').value.trim() };
      if (!c.url || !c.model || !c.key) { alert('请填写接口地址、模型名和 API Key'); return; }
      cfg = c; store(cfg); cfgBox.hidden = true; tip();
    };
    $a('del').onclick = () => { if (cfg) { cfg.key = ''; store(cfg.url ? cfg : null); } $f('key').value = ''; tip(); };
    $a('new').onclick = () => { hist = []; sentCtx = ''; msgs.innerHTML = ''; };
    // 全屏 / 收起
    let backY = 0;                                   // 收起后回到放大前的页面位置
    const full = on => {
      if (on === box.classList.contains('full')) return;
      if (on) backY = window.scrollY;
      box.classList.toggle('full', on);
      document.documentElement.style.overflow = on ? 'hidden' : '';
      if (!on) { $f('q').blur(); window.scrollTo(0, backY); }
    };
    $a('close').onclick = () => full(false);
    $f('q').addEventListener('focus', () => full(true));
    msgs.addEventListener('click', () => full(true));
    const toast = t => { const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; box.appendChild(d); setTimeout(() => d.remove(), 1800); };
    const refresh = () => { $f('ctx').value = summarize(getState()); ctxDirty = false; };
    $a('ref').onclick = refresh;
    $f('ctx').oninput = () => { ctxDirty = true; };
    box.querySelector('details.ctx').ontoggle = e => { if (e.target.open && !ctxDirty) refresh(); };

    const bubble = (cls, html) => { const d = document.createElement('div'); d.className = 'm ' + cls; d.innerHTML = html; msgs.appendChild(d); return d; };
    const compose = q => {
      if (!ctxDirty) refresh();
      const ctx = $f('use').checked ? $f('ctx').value.trim() : '';
      const extra = ctx && ctx !== sentCtx ? (sentCtx ? '【数据已更新】\n' : '【当前数据】\n') + ctx + '\n\n【问题】\n' : '';
      return { text: extra + q, ctx };
    };
    async function send() {
      const q = $f('q').value.trim();
      if (!q || busy) return;
      if (!cfg || !cfg.key) { cfgBox.hidden = false; fillCfg(); alert('请先在“设置”里填写 API Key；没有 Key 可以用报文列表下的“📋 复制给 AI 助手”，粘贴到其他 AI 使用。'); return; }
      const { text, ctx } = compose(q);
      busy = true; $a('send').disabled = true;
      bubble('u', esc(q));
      box.querySelector('details.ctx').open = false;   // 发出后收起附带数据，聊天区更大
      const a = bubble('a', '<span style="color:var(--muted)">思考中…</span>');
      hist.push({ role: 'user', content: text });
      $f('q').value = '';
      try {
        const ans = await chat(cfg, hist, t => { a.innerHTML = md(t); });
        if (!ans) a.innerHTML = '<span style="color:var(--muted)">（没有返回内容）</span>';
        hist.push({ role: 'assistant', content: ans || '（无回答）' });
        sentCtx = ctx || sentCtx;
      } catch (e) {
        hist.pop();
        a.remove();
        bubble('e', esc(e.message || e));
        $f('q').value = q;
      }
      busy = false; $a('send').disabled = false;
      a.scrollIntoView && a.scrollIntoView({ block: 'nearest' });
    }
    $a('send').onclick = send;
    $f('q').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
    tip();
    // 页面上的“复制给 AI 助手”按钮：按当前页面整理数据（含选取的报文）→ 复制到剪贴板，并附带到 AI 助手、打开聊天。
    // 本次打开网页后第一次复制时询问是否按提问模板（身份设定 + 数据 + 问题）复制；之后只复制内容，不再询问。
    // 复制必须在用户点按的那一下同步完成（浏览器只在用户操作时允许写剪贴板），所以在按钮 / 弹窗按钮的点击里直接复制。
    let asked = false;
    const modal = (html, onClick) => {
      const m = document.createElement('div');
      m.className = 'ai-modal';
      m.innerHTML = `<div class="box">${html}</div>`;
      m.onclick = e => { const v = e.target.dataset.v; if (v === undefined) return; m.remove(); onClick(v); };
      document.body.appendChild(m);
      return m;
    };
    // 老方法：临时文本框选中后 execCommand('copy')，UC / 部分国产浏览器只认这种
    function legacyCopy(text) {
      const t = document.createElement('textarea');
      t.value = text;
      t.setAttribute('readonly', '');
      t.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;border:0;padding:0';
      document.body.appendChild(t);
      t.select();
      t.setSelectionRange(0, text.length);
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      t.remove();
      return ok;
    }
    // 两种方法都失败：显示内容并全选，让用户长按复制
    function manualCopy(text, then) {
      const m = modal(`<b>浏览器不允许自动复制</b><p>请长按下方文字 → 全选 → 复制，然后点“好了”。</p>
        <textarea readonly class="mc">${esc(text)}</textarea><div class="row"><button class="p" data-v="1">好了</button></div>`, then);
      const t = m.querySelector('textarea');
      setTimeout(() => { t.focus(); t.select(); t.setSelectionRange(0, text.length); }, 50);
    }
    // 依次尝试：新方法（Clipboard API，苹果 / Chrome 正常）→ 老方法 → 显示全选框手动复制
    function copyText(text, then) {           // then(ok)：ok=true 已复制；false 走了手动复制
      const fallback = () => legacyCopy(text) ? then(true) : manualCopy(text, () => then(false));
      let p = null;
      try { if (navigator.clipboard && window.isSecureContext) p = navigator.clipboard.writeText(text); } catch (e) {}
      if (p) p.then(() => then(true), fallback); else fallback();
    }
    function takeData() {
      refresh();
      $f('use').checked = true;
      const data = $f('ctx').value;
      const done = ok => { full(true); $f('q').focus(); toast(ok ? '已复制，并已附带到 AI 助手' : '已附带到 AI 助手'); };
      if (asked) return copyText(data, done);
      asked = true;
      modal(`<b>是否按提问模板复制？</b>
        <p>选“是”：开头附带诊断工程师的身份和回答要求、末尾留出问题，适合直接粘贴到其他 AI 提问。<br>选“否”：只复制选取的报文 / 数据。<br>本次打开网页只问这一次，之后都只复制内容。</p>
        <div class="row"><button class="b" data-v="0">否</button><button class="p" data-v="1">是</button></div>`,
        v => copyText(v === '1' ? SYSTEM + '\n\n【当前数据】\n' + data + '\n\n【问题】\n（请在这里写下你的问题）' : data, done));
    }
    return { takeData, full };
  }

  return { mount, summarize, chat, PRESETS };
})();
if (typeof module !== 'undefined') module.exports = AI;
