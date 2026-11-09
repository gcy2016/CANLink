// 刷写文件解析：Motorola S19 / Intel HEX / 原始 bin → 连续段 [{addr, data:Uint8Array}]。
// 纯逻辑，可在 node 里自测。解析出来的刷写数据是实车固件，不进仓库。
(() => {
  // 把 [{addr,byte}] 之类的稀疏字节按地址连续与否合并成段
  function toSegments(chunks) {
    // chunks: [{addr, data:Uint8Array}]，按地址排序后合并相邻（addr 紧接）的块
    chunks.sort((a, b) => a.addr - b.addr);
    const segs = [];
    for (const c of chunks) {
      if (!c.data.length) continue;
      const last = segs[segs.length - 1];
      if (last && c.addr === last.addr + last.data.length) {
        const merged = new Uint8Array(last.data.length + c.data.length);
        merged.set(last.data); merged.set(c.data, last.data.length);
        last.data = merged;
      } else if (last && c.addr < last.addr + last.data.length) {
        throw new Error(`地址重叠：0x${c.addr.toString(16)}`);
      } else segs.push({ addr: c.addr >>> 0, data: c.data });
    }
    return segs;
  }

  function parseHex(byteStr, i, n) {
    let v = 0; for (let k = 0; k < n; k++) v = (v << 4) | parseInt(byteStr[i + k], 16);
    return v >>> 0;
  }
  function bytesFrom(line, start, count) {
    const a = new Uint8Array(count);
    for (let i = 0; i < count; i++) a[i] = parseHex(line, start + i * 2, 2);
    return a;
  }

  // Intel HEX
  function parseIHEX(text) {
    const chunks = []; let base = 0, lineNo = 0;
    for (let raw of text.split(/\r?\n/)) {
      const line = raw.trim(); lineNo++;
      if (!line) continue;
      if (line[0] !== ':') throw new Error(`HEX 第 ${lineNo} 行不是以 ':' 开头`);
      const len = parseHex(line, 1, 2), addr = parseHex(line, 3, 4), type = parseHex(line, 7, 2);
      if (line.length < 11 + len * 2) throw new Error(`HEX 第 ${lineNo} 行长度不足`);
      // 校验和
      let sum = 0; for (let i = 1; i < 9 + len * 2 + 2; i += 2) sum = (sum + parseHex(line, i, 2)) & 0xFF;
      if (sum !== 0) throw new Error(`HEX 第 ${lineNo} 行校验和错`);
      if (type === 0x00) chunks.push({ addr: (base + addr) >>> 0, data: bytesFrom(line, 9, len) });
      else if (type === 0x01) break;                       // EOF
      else if (type === 0x02) base = parseHex(line, 9, 4) << 4;   // 扩展段地址
      else if (type === 0x04) base = parseHex(line, 9, 4) << 16;  // 扩展线性地址
      // 03/05 起始地址：忽略
    }
    return toSegments(chunks);
  }

  // Motorola S19 / S28 / S37
  function parseS19(text) {
    const chunks = []; let lineNo = 0;
    for (let raw of text.split(/\r?\n/)) {
      const line = raw.trim(); lineNo++;
      if (!line) continue;
      if (line[0] !== 'S') throw new Error(`S19 第 ${lineNo} 行不是以 'S' 开头`);
      const t = line[1];
      if (t === '0' || t === '5' || t === '7' || t === '8' || t === '9') continue; // 头/计数/结束
      const count = parseHex(line, 2, 2);                 // 后面的字节数（含地址、数据、校验和）
      const alen = t === '1' ? 2 : t === '2' ? 3 : 4;     // 地址字节数
      const addr = parseHex(line, 4, alen * 2);
      // 校验和
      let sum = 0; for (let i = 2; i < 2 + (count + 1) * 2; i += 2) sum = (sum + parseHex(line, i, 2)) & 0xFF;
      if (sum !== 0xFF) throw new Error(`S19 第 ${lineNo} 行校验和错`);
      const dataLen = count - alen - 1;
      chunks.push({ addr: addr >>> 0, data: bytesFrom(line, 4 + alen * 2, dataLen) });
    }
    return toSegments(chunks);
  }

  // 自动识别：以 ':' 开头是 HEX，'S' 开头是 S19，否则当成原始 bin（需给起始地址）
  function parse(nameOrText, text, binAddr) {
    const name = text === undefined ? '' : nameOrText;
    const body = text === undefined ? nameOrText : text;
    if (typeof body === 'string') {
      const h = body.replace(/^﻿/, '').trimStart();
      if (h[0] === ':') return { type: 'hex', segs: parseIHEX(body) };
      if (h[0] === 'S' && /[0-9]/.test(h[1])) return { type: 's19', segs: parseS19(body) };
    }
    // 原始 bin：body 是 Uint8Array / ArrayBuffer
    const data = body instanceof Uint8Array ? body : new Uint8Array(body);
    return { type: 'bin', segs: [{ addr: (binAddr || 0) >>> 0, data }] };
  }

  const total = segs => segs.reduce((s, x) => s + x.data.length, 0);
  const API = { parse, parseIHEX, parseS19, toSegments, total };
  if (typeof module !== 'undefined') module.exports = API;
  if (typeof window !== 'undefined') window.FlashFile = API;
})();
