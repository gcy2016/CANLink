// 自测：node canlink/test/test_web.js
// 位时间计算、slcan 命令和解析、ASC 生成（并用 SEF 网站的 ASC 读取代码读回来核对）。
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const Slcan = require(path.join(root, 'docs/canlink/slcan.js'));
const Recorder = require(path.join(root, 'docs/canlink/recorder.js'));
global.Blob = require('buffer').Blob;
const CanLog = require(path.join(root, 'tools/web/canlog.js'));

let n = 0;
const ok = (name, fn) => Promise.resolve(fn()).then(() => { n++; console.log('✓', name); });

(async () => {
  await ok('位时间：500k 80%', () => {
    const t = Slcan.timing(80e6, 500000, 0.8, 'nominal');
    assert.deepStrictEqual([t.brp * t.tq, t.sp], [160, 0.8]);
    assert.strictEqual(80e6 / (t.brp * (1 + t.tseg1 + t.tseg2)), 500000);
  });
  await ok('位时间：2M 75% / 5M 75% / 8M 80%', () => {
    for (const [r, sp] of [[2e6, 0.75], [5e6, 0.75], [8e6, 0.8], [4e6, 0.7], [1e6, 0.8]]) {
      const t = Slcan.timing(80e6, r, sp, 'data');
      assert(t, r);
      assert.strictEqual(80e6 / (t.brp * (1 + t.tseg1 + t.tseg2)), r);
      assert(t.tseg1 <= 32 && t.tseg2 <= 16 && t.sjw <= t.tseg2);
      assert(Math.abs(t.sp - sp) < 0.05, `${r} ${t.sp}`);
      assert(t.brp * (1 + t.tseg1) <= 127, 'TDC 偏移 ≤127');
    }
  });
  await ok('位时间：凑不出整数时返回 null', () => {
    assert.strictEqual(Slcan.timing(80e6, 3e6, 0.75, 'data'), null);
  });
  await ok('命令：普通帧 / 扩展 FD BRS / 填充', () => {
    assert.strictEqual(Slcan.frameCmd({ id: 0x7DF, data: [2, 0x10, 3] }), 't7DF3021003');
    assert.strictEqual(Slcan.frameCmd({ id: 0x18DA10F1, ext: true, fd: true, brs: true, data: new Array(10).fill(1) }),
      'B18DA10F19' + '01'.repeat(10) + 'CCCC');
    assert.throws(() => Slcan.frameCmd({ id: 0x800, data: [] }));
    assert.throws(() => Slcan.frameCmd({ id: 1, data: new Array(9).fill(0) }));
  });
  await ok('解析：带微秒时间戳 / 发送回显 / 状态', () => {
    const f = Slcan.parseLine('b12390102030405060708090A0B0C0012D687', 2);
    assert.strictEqual(f.id, 0x123); assert(f.fd && f.brs && !f.ext && !f.tx);
    assert.strictEqual(f.data.length, 12); assert.strictEqual(f.ts, 0x0012D687);
    const e = Slcan.parseLine('>T18DA10F18' + '0210030000000000' + '00000001', 2);
    assert(e.tx && e.ext); assert.strictEqual(e.id, 0x18DA10F1); assert.strictEqual(e.ts, 1);
    const s = Slcan.parseLine('xS1,0,00000707,00000000,00000000,3,-850,1,64', 0);
    assert.strictEqual(s.kind, 'status'); assert.strictEqual(s.ppm, -850); assert.strictEqual(s.rxDropped, 3);
    const i = Slcan.parseLine('xIvdlink,1.0,80000000', 0);
    assert.strictEqual(i.clock, 80e6);
    const r = Slcan.parseLine('r7FF8', 0); assert(r.rtr); assert.strictEqual(r.data.length, 0);
  });
  await ok('时间戳展开：32 位回绕 + ppm 修正', () => {
    const c = new Slcan.Clock();
    assert.strictEqual(c.seconds(0xFFFFFF00), 0);
    assert(Math.abs(c.seconds(0x100) - 512e-6) < 1e-9);
    const c2 = new Slcan.Clock(); c2.ppm = 1000;
    c2.seconds(0); assert(Math.abs(c2.seconds(1001000) - 1.0) < 1e-9);
  });
  await ok('按行切分：\\r 和 \\a', () => {
    const got = [];
    const lr = new Slcan.LineReader((l, err) => got.push([l, err]));
    lr.push('t1232AB'); lr.push('CD\r\x07\rxS');
    assert.deepStrictEqual(got, [['t1232ABCD', false], ['', true], ['', false]]);
  });
  await ok('录制 → ASC → SEF 读回一致（含截取时间段）', async () => {
    const rec = new Recorder();
    const frames = [];
    for (let i = 0; i < 70000; i++) {   // 超过一块，测试封存
      const fd = i % 3 === 0, len = fd ? [0, 8, 12, 64][i % 4] : i % 9;
      const data = Uint8Array.from({ length: len }, (_, k) => (i + k) & 0xFF);
      const f = { id: fd ? 0x18DA10F1 : (i % 0x7FF), ext: fd, fd, brs: fd && i % 2 === 0, tx: i % 5 === 0,
        dlc: fd ? Slcan.LEN_DLC(len) : len, data };
      const t = i * 0.001;
      rec.push(t, f); frames.push([t, f]);
      if (i === 100) rec.mark(t);
    }
    const blob = await rec.toASC();
    const text = await blob.text();
    assert(/^date \w{3} \w{3} \d\d /.test(text));
    assert(text.includes('// 0.100000 Mark 1'));
    const fr = await CanLog.read('x.asc', new TextEncoder().encode(text));
    assert.strictEqual(fr.n, frames.length);
    for (const k of [0, 1, 3, 12345, 69999]) {
      const [t, f] = frames[k];
      assert(Math.abs(fr.t[k] - t) < 1e-6, `t ${k}`);
      assert.strictEqual(fr.id[k] & 0x1FFFFFFF, f.id);
      assert.strictEqual(!!(fr.fl[k] & 1), f.tx);
      assert.strictEqual(!!(fr.fl[k] & 2), f.fd);
      assert.deepStrictEqual(Array.from(fr.bytes(k)), Array.from(f.data));
    }
    const seg = await (await rec.toASC(10, 20)).text();
    const fr2 = await CanLog.read('y.asc', new TextEncoder().encode(seg));
    assert.strictEqual(fr2.n, 10001);
    assert(Math.abs(fr2.t[0]) < 1e-9 && Math.abs(fr2.t[fr2.n - 1] - 10) < 1e-6);
  });
  console.log(`全部通过（${n} 项）`);
})().catch(e => { console.error('✗', e); process.exit(1); });
