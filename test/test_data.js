// 内置资料（docs/data.js）自测：按 tools/build.py 的方案加密（gzip → PBKDF2-SHA256 → AES-256-GCM），用网页的代码解回来。
const assert = require('assert');
const zlib = require('zlib');
const { webcrypto: wc } = require('crypto');
require('../docs/data.js');
const { decrypt } = globalThis.CanlinkData;

async function encrypt(obj, pin, iter) {
  const salt = wc.getRandomValues(new Uint8Array(16)), iv = wc.getRandomValues(new Uint8Array(12));
  const k0 = await wc.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  const key = await wc.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, k0, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = await wc.subtle.encrypt({ name: 'AES-GCM', iv }, key, zlib.gzipSync(Buffer.from(JSON.stringify(obj))));
  const b64 = b => Buffer.from(b).toString('base64');
  return { v: 2, iter, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

(async () => {
  let n = 0;
  const ok = async (name, fn) => { await fn(); n++; console.log('✓ ' + name); };
  const data = { models: [{ model: 'C363', dbc: 'X', items: [{ d: 'C100104', hm: '5001', l: '04', desc: '中文描述' }] }], dbcs: { X: { name: 'X', msgs: [] } } };
  const enc = await encrypt(data, '密码abc123', 1000);
  await ok('密码对：解出来和原来一样', async () => assert.deepStrictEqual(await decrypt(enc, '密码abc123'), data));
  await ok('密码错：报错', async () => assert.rejects(decrypt(enc, 'wrong')));
  await ok('密文被改：报错', async () => assert.rejects(decrypt({ ...enc, ct: enc.ct.slice(0, -8) + 'AAAAAAA=' }, '密码abc123')));
  console.log(`全部通过（${n} 项）`);
})().catch(e => { console.error(e); process.exit(1); });
