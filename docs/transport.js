// USB 连接：电脑用 Web Serial（系统已经把 CANable 认成串口），
// 安卓用 WebUSB 直接操作 USB 串口（CDC-ACM）接口。两者对上层提供同样的接口：
//   open() / write(text) / close()，收到数据调用 onData(text)，断开调用 onClose()
const Transport = (() => {
  const FILTERS = [
    { vendorId: 0x16d0, productId: 0x117e },   // CANable 2.0 slcan / vdlink
  ];

  const enc = new TextEncoder(), dec = new TextDecoder('latin1');

  class SerialTransport {
    static available() { return typeof navigator !== 'undefined' && !!navigator.serial; }
    constructor() { this.kind = 'serial'; this.onData = null; this.onClose = null; }
    async open(port) {
      this.port = port || await navigator.serial.requestPort({ filters: FILTERS.map(f => ({ usbVendorId: f.vendorId, usbProductId: f.productId })) });
      await this.port.open({ baudRate: 115200, bufferSize: 65536 });
      this.writer = this.port.writable.getWriter();
      this.reading = this.readLoop();
      this.name = 'USB 串口';
    }
    async readLoop() {
      while (this.port && this.port.readable) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value && this.onData) this.onData(dec.decode(value));
          }
        } catch (e) {
          break;
        } finally {
          try { this.reader.releaseLock(); } catch (e) { /* ignore */ }
        }
      }
      if (this.onClose && !this.closing) this.onClose();
    }
    async write(text) { await this.writer.write(enc.encode(text)); }
    async close() {
      this.closing = true;
      try { await this.reader.cancel(); } catch (e) { /* ignore */ }
      try { this.writer.releaseLock(); } catch (e) { /* ignore */ }
      try { await this.port.close(); } catch (e) { /* ignore */ }
      this.port = null;
    }
  }

  class UsbTransport {
    static available() { return typeof navigator !== 'undefined' && !!navigator.usb; }
    constructor() { this.kind = 'usb'; this.onData = null; this.onClose = null; }
    async open(device) {
      this.dev = device || await navigator.usb.requestDevice({ filters: FILTERS });
      await this.dev.open();
      if (!this.dev.configuration) await this.dev.selectConfiguration(1);
      // 找 CDC 控制接口（class 2）和数据接口（class 10）
      let ctrl = null, data = null;
      for (const itf of this.dev.configuration.interfaces) {
        const alt = itf.alternates[0];
        if (alt.interfaceClass === 2 && ctrl === null) ctrl = itf.interfaceNumber;
        if (alt.interfaceClass === 10) {
          data = itf.interfaceNumber;
          for (const ep of alt.endpoints) {
            if (ep.type !== 'bulk') continue;
            if (ep.direction === 'in') { this.epIn = ep.endpointNumber; this.inSize = ep.packetSize; }
            else this.epOut = ep.endpointNumber;
          }
        }
      }
      if (data === null || !this.epIn || !this.epOut) throw new Error('这个设备不是 USB 串口（CDC）设备');
      if (ctrl !== null) {
        try { await this.dev.claimInterface(ctrl); } catch (e) { /* 部分系统不让占控制接口，没关系 */ }
      }
      await this.dev.claimInterface(data);
      if (ctrl !== null) {
        // SET_CONTROL_LINE_STATE：DTR/RTS 置位（有的固件只在置位后才发数据）
        try {
          await this.dev.controlTransferOut({ requestType: 'class', recipient: 'interface', request: 0x22, value: 3, index: ctrl });
        } catch (e) { /* ignore */ }
      }
      this.name = this.dev.productName || 'USB 设备';
      this.serialNumber = this.dev.serialNumber || '';   // 刷写指纹的诊断仪编号优先用它
      this.running = true;
      this.reading = this.readLoop();
    }
    async readLoop() {
      while (this.running) {
        try {
          const r = await this.dev.transferIn(this.epIn, 4096);
          if (r.data && r.data.byteLength && this.onData) this.onData(dec.decode(r.data));
        } catch (e) {
          break;
        }
      }
      if (this.onClose && !this.closing) this.onClose();
    }
    async write(text) {
      const b = enc.encode(text);
      for (let i = 0; i < b.length; i += 4096) await this.dev.transferOut(this.epOut, b.subarray(i, i + 4096));
    }
    async close() {
      this.closing = true; this.running = false;
      try { await this.dev.close(); } catch (e) { /* ignore */ }
    }
  }

  // 安卓 APK 里的原生 USB 桥（以后做 APK 用）：APK 用 Java 实现 USB 串口，注入 window.VdlinkNative：
  //   open() → 设备名（失败抛异常），write(text)，close()
  // 收到数据、断开时调用 window.__vdlinkNative.onData(text) / onClose()
  class NativeTransport {
    static available() { return typeof window !== 'undefined' && !!window.VdlinkNative; }
    constructor() { this.kind = 'native'; this.onData = null; this.onClose = null; }
    async open() {
      window.__vdlinkNative = { onData: t => this.onData && this.onData(t), onClose: () => this.onClose && !this.closing && this.onClose() };
      this.name = window.VdlinkNative.open() || 'USB 设备';
    }
    async write(text) { window.VdlinkNative.write(text); }
    async close() { this.closing = true; try { window.VdlinkNative.close(); } catch (e) { /* ignore */ } }
  }

  const isAndroid = () => typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

  // 选一个合适的方式：安卓优先 WebUSB，电脑优先 Web Serial
  function pick() {
    if (NativeTransport.available()) return new NativeTransport();
    if (isAndroid()) {
      if (UsbTransport.available()) return new UsbTransport();
      if (SerialTransport.available()) return new SerialTransport();
    } else {
      if (SerialTransport.available()) return new SerialTransport();
      if (UsbTransport.available()) return new UsbTransport();
    }
    return null;
  }

  // 已经授权过的设备（不弹窗）：返回 { transport, handle } 或 null
  async function known() {
    try {
      const want = (vid, pid) => FILTERS.some(f => f.vendorId === vid && f.productId === pid);
      if (isAndroid() || !SerialTransport.available()) {
        if (UsbTransport.available()) {
          const d = (await navigator.usb.getDevices()).find(x => want(x.vendorId, x.productId));
          if (d) return { transport: new UsbTransport(), handle: d };
        }
      } else {
        const p = (await navigator.serial.getPorts()).find(x => { const i = x.getInfo(); return want(i.usbVendorId, i.usbProductId); });
        if (p) return { transport: new SerialTransport(), handle: p };
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  return { SerialTransport, UsbTransport, NativeTransport, pick, known, isAndroid, FILTERS };
})();
if (typeof module !== 'undefined') module.exports = Transport;
