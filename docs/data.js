// 内置资料：各车型的诊断问卷 + DBC 信号定义，加密放在 data.enc.json（tools/build.py 生成）。
// 用网页密码解开（和 secrets.enc.json 同一个密码、同一套方案：PBKDF2-SHA256 + AES-256-GCM，明文先 gzip）。
// 主页面和“离线数据”页共用；密码是开屏解锁时记在本机的那个，没解锁过就取不到。
(function (root) {
  const base = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || (root.location ? root.location.href : '');
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  async function decrypt(enc, pin) {
    const k0 = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b64(enc.salt), iterations: enc.iter },
      k0, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    let pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(enc.iv) }, key, b64(enc.ct));
    if (enc.v === 2) pt = await new Response(new Blob([pt]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    return JSON.parse(new TextDecoder().decode(pt));
  }

  function savedPin() {
    try { return JSON.parse(localStorage.getItem('canlink.pin')) || ''; } catch (e) { return ''; }
  }

  // 取内置资料 { models: [{ model, items, dbc }], dbcs: { 名字: DBC } }；只解一次，失败（没密码 / 密码不对 / 没网）下次再试
  let cache = null;
  function get() {
    if (!cache) {
      cache = (async () => {
        const pin = savedPin();
        if (!pin) throw new Error('还没解锁');
        const enc = await (await fetch(new URL('data.enc.json', base), { cache: 'no-cache' })).json();
        return decrypt(enc, pin);
      })();
      cache.catch(() => { cache = null; });
    }
    return cache;
  }

  root.CanlinkData = { get, decrypt };
})(globalThis);
