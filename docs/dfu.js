// 用 WebUSB 给 STM32 刷固件（芯片自带的 DFU 烧录模式，DfuSe 协议）。
// 板子用导线短接 BOOT 再接 USB，就进入烧录模式（USB ID 0483:df11）。
const Dfu = (() => {
  const DETACH = 0, DNLOAD = 1, UPLOAD = 2, GETSTATUS = 3, CLRSTATUS = 4, ABORT = 6;
  const S = { dfuIDLE: 2, dfuDNLOAD_SYNC: 3, dfuDNBUSY: 4, dfuDNLOAD_IDLE: 5, dfuMANIFEST_SYNC: 6, dfuMANIFEST: 7, dfuUPLOAD_IDLE: 9, dfuERROR: 10 };
  const FLASH_BASE = 0x08000000;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  class StmDfu {
    constructor(log) { this.log = log || (() => {}); }

    async open(device) {
      this.dev = device || await navigator.usb.requestDevice({ filters: [{ vendorId: 0x0483, productId: 0xdf11 }] });
      await this.dev.open();
      if (!this.dev.configuration) await this.dev.selectConfiguration(1);
      // 接口 0 的各个 alternate 对应不同存储区，名字形如 "@Internal Flash  /0x08000000/32*02Kg"
      const itf = this.dev.configuration.interfaces[0];
      this.itf = itf.interfaceNumber;
      let alt = 0;
      for (const a of itf.alternates) if (/Internal Flash/i.test(a.interfaceName || '')) { alt = a.alternateSetting; this.layout = a.interfaceName; break; }
      await this.dev.claimInterface(this.itf);
      await this.dev.selectAlternateInterface(this.itf, alt);
      this.pageSize = 2048;
      const m = /\/0x0*8000000\/(\d+)\*(\d+)(\w)/i.exec(this.layout || '');
      if (m) this.pageSize = +m[2] * (/K/i.test(m[3]) ? 1024 : 1);
      this.xfer = await this.transferSize();
      this.log(`已连接烧录模式：${this.dev.productName || 'STM32 DFU'}${this.layout ? '，' + this.layout.trim() : ''}`);
    }

    // 从配置描述符里读 DFU 功能描述符（类型 0x21）的 wTransferSize
    async transferSize() {
      try {
        const r = await this.dev.controlTransferIn({ requestType: 'standard', recipient: 'device', request: 6, value: 0x0200, index: 0 }, 512);
        const d = new Uint8Array(r.data.buffer);
        for (let i = 0; i + 1 < d.length && d[i] > 0; i += d[i]) {
          if (d[i + 1] === 0x21 && d[i] >= 7) return Math.min(d[i + 5] | (d[i + 6] << 8), 2048) || 1024;
        }
      } catch (e) { /* 读不到就用保守值 */ }
      return 1024;
    }

    async ctrlOut(request, value, data) {
      const r = await this.dev.controlTransferOut({ requestType: 'class', recipient: 'interface', request, value, index: this.itf }, data || new ArrayBuffer(0));
      if (r.status !== 'ok') throw new Error(`DFU 命令 ${request} 失败：${r.status}`);
    }
    async ctrlIn(request, value, length) {
      const r = await this.dev.controlTransferIn({ requestType: 'class', recipient: 'interface', request, value, index: this.itf }, length);
      if (r.status !== 'ok') throw new Error(`DFU 命令 ${request} 失败：${r.status}`);
      return r.data;
    }
    async status() {
      const d = await this.ctrlIn(GETSTATUS, 0, 6);
      return { status: d.getUint8(0), poll: d.getUint8(1) | (d.getUint8(2) << 8) | (d.getUint8(3) << 16), state: d.getUint8(4) };
    }
    // 等命令执行完（忙的时候按设备给的时间再问）
    async waitIdle(want) {
      for (let i = 0; i < 2000; i++) {
        const s = await this.status();
        if (s.state === S.dfuERROR || s.status !== 0) throw new Error(`DFU 出错（状态 ${s.state}，代码 ${s.status}）`);
        if (s.state === want) return s;
        await sleep(Math.max(s.poll, 5));
      }
      throw new Error('DFU 等待超时');
    }
    async toIdle() {
      let s = await this.status();
      if (s.state === S.dfuERROR) { await this.ctrlOut(CLRSTATUS, 0); s = await this.status(); }
      if (s.state !== S.dfuIDLE) { await this.ctrlOut(ABORT, 0); s = await this.status(); }
      if (s.state !== S.dfuIDLE) throw new Error('设备没回到空闲状态（' + s.state + '）');
    }
    async special(cmd, addr) {
      const b = new Uint8Array(addr === undefined ? 1 : 5);
      b[0] = cmd;
      if (addr !== undefined) new DataView(b.buffer).setUint32(1, addr, true);
      await this.ctrlOut(DNLOAD, 0, b);
      await this.waitIdle(S.dfuDNLOAD_IDLE);
    }

    // 擦除 + 写入 + 校验，然后让芯片运行新固件。progress(0..1, 文字)
    async flash(bin, progress) {
      const p = progress || (() => {});
      const u8 = new Uint8Array(bin);
      await this.toIdle();

      const pages = Math.ceil(u8.length / this.pageSize);
      for (let i = 0; i < pages; i++) {
        await this.special(0x41, FLASH_BASE + i * this.pageSize);
        p(0.3 * (i + 1) / pages, `擦除 ${i + 1}/${pages}`);
      }

      // 每块都先设地址、块号固定用 2，不依赖设备的块号换算
      const blocks = Math.ceil(u8.length / this.xfer);
      for (let i = 0; i < blocks; i++) {
        const chunk = u8.subarray(i * this.xfer, (i + 1) * this.xfer);
        await this.special(0x21, FLASH_BASE + i * this.xfer);
        await this.ctrlOut(DNLOAD, 2, chunk);
        await this.waitIdle(S.dfuDNLOAD_IDLE);
        p(0.3 + 0.5 * (i + 1) / blocks, `写入 ${Math.min((i + 1) * this.xfer, u8.length)}/${u8.length} 字节`);
      }

      // 校验：重新设地址，读回来比对
      for (let i = 0; i < blocks; i++) {
        const want = u8.subarray(i * this.xfer, (i + 1) * this.xfer);
        await this.toIdle();
        await this.special(0x21, FLASH_BASE + i * this.xfer);
        await this.toIdle();
        const got = new Uint8Array((await this.ctrlIn(UPLOAD, 2, want.length)).buffer);
        for (let k = 0; k < want.length; k++) {
          if (got[k] !== want[k]) throw new Error(`校验失败：地址 0x${(FLASH_BASE + i * this.xfer + k).toString(16)}`);
        }
        p(0.8 + 0.2 * (i + 1) / blocks, `校验 ${i + 1}/${blocks}`);
      }

      // 退出烧录模式：设地址后发 0 长度下载，芯片跳去运行固件
      await this.toIdle();
      await this.special(0x21, FLASH_BASE);
      try {
        await this.ctrlOut(DNLOAD, 0, new ArrayBuffer(0));
        await this.status();
      } catch (e) { /* 芯片已经复位，USB 断开是正常的 */ }
      p(1, '完成');
    }

    async close() { try { await this.dev.close(); } catch (e) { /* ignore */ } }
  }

  return { StmDfu, DETACH };
})();
if (typeof module !== 'undefined') module.exports = Dfu;
