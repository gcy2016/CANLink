// 自测：node canlink/test/test_dfu.js
// 用一个模拟的 STM32 DFU 设备（按 DfuSe 协议）检查刷写流程：擦除、写入、校验、退出。
const assert = require('assert');
const path = require('path');
const Dfu = require(path.join(__dirname, '..', 'docs/dfu.js'));
global.navigator = {};

function fakeDevice(transferSize) {
  const flash = new Uint8Array(64 * 1024).fill(0xFF);
  const base = 0x08000000;
  let state = 2, ptr = base, pending = null, erased = new Set(), left = false;
  const cfg = new Uint8Array([9, 2, 36, 0, 1, 1, 0, 0x80, 50, 9, 4, 0, 0, 0, 0xFE, 1, 2, 0,
    9, 0x21, 0x0B, 255, 0, transferSize & 0xFF, transferSize >> 8, 0x1A, 0x01]);
  const dv = a => new DataView(Uint8Array.from(a).buffer);
  return {
    flash, erased, get left() { return left; },
    productName: 'STM32  BOOTLOADER', configuration: { interfaces: [{ interfaceNumber: 0, alternates: [
      { alternateSetting: 0, interfaceName: '@Internal Flash  /0x08000000/32*02Kg' },
      { alternateSetting: 1, interfaceName: '@Option Bytes  /0x1FFF7800/01*048 e' }] }] },
    async open() {}, async close() {}, async claimInterface() {}, async selectAlternateInterface() {},
    async controlTransferIn(setup, len) {
      if (setup.requestType === 'standard') return { status: 'ok', data: dv(cfg) };
      if (setup.request === 3) { // GETSTATUS
        if (pending) { const p = pending; pending = null; p(); }
        return { status: 'ok', data: dv([0, 1, 0, 0, state, 0]) };
      }
      if (setup.request === 2) { // UPLOAD
        assert.strictEqual(state, 2, 'UPLOAD 前要回到空闲');
        const addr = ptr + (setup.value - 2) * transferSize;
        state = 9;
        return { status: 'ok', data: new DataView(flash.slice(addr - base, addr - base + len).buffer) };
      }
      throw new Error('unexpected in ' + setup.request);
    },
    async controlTransferOut(setup, data) {
      const d = new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
      if (setup.request === 6 || setup.request === 4) { state = 2; return { status: 'ok' }; }
      if (setup.request !== 1) throw new Error('unexpected out ' + setup.request);
      if (setup.value === 0) {
        if (d.length === 0) { left = true; state = 7; return { status: 'ok' }; }
        const cmd = d[0], addr = d.length >= 5 ? new DataView(d.buffer).getUint32(1, true) : 0;
        state = 4;
        pending = () => {
          if (cmd === 0x21) ptr = addr;
          else if (cmd === 0x41) { assert.strictEqual((addr - base) % 2048, 0); flash.fill(0xFF, addr - base, addr - base + 2048); erased.add(addr); }
          state = 5;
        };
        return { status: 'ok' };
      }
      assert(d.length <= transferSize, '块太大');
      const addr = ptr + (setup.value - 2) * transferSize;
      for (let i = 0; i < d.length; i++) { assert.strictEqual(flash[addr - base + i], 0xFF, '写到没擦的地方'); }
      state = 4;
      pending = () => { flash.set(d, addr - base); state = 5; };
      return { status: 'ok' };
    },
  };
}

(async () => {
  for (const ts of [2048, 1024, 256]) {
    const dev = fakeDevice(ts);
    const bin = Uint8Array.from({ length: 28800 }, (_, i) => (i * 7 + 3) & 0xFF);
    const d = new Dfu.StmDfu();
    await d.open(dev);
    assert.strictEqual(d.pageSize, 2048);
    assert.strictEqual(d.xfer, ts);
    let last = 0;
    await d.flash(bin, p => { assert(p >= last); last = p; });
    assert.deepStrictEqual(Array.from(dev.flash.subarray(0, bin.length)), Array.from(bin));
    assert.strictEqual(dev.erased.size, Math.ceil(bin.length / 2048));
    assert(dev.left, '最后要退出烧录模式');
    console.log(`✓ 传输块 ${ts}：擦除 ${dev.erased.size} 页、写入并校验 ${bin.length} 字节`);
  }
  // 校验能发现写坏
  const dev = fakeDevice(1024);
  const orig = dev.controlTransferOut;
  dev.controlTransferOut = async (s, data) => {
    if (s.request === 1 && s.value === 2 && data.byteLength) { const c = new Uint8Array(data); c[0] ^= 1; return orig(s, c); }
    return orig(s, data);
  };
  const d = new Dfu.StmDfu(); await d.open(dev);
  await assert.rejects(d.flash(new Uint8Array(3000).fill(0x55)), /校验失败/);
  console.log('✓ 写坏能被校验发现');
})().catch(e => { console.error('✗', e); process.exit(1); });
