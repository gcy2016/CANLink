// 极简 DBC 解析（浏览器端）：只取画曲线和识别故障码要用的部分（报文、信号、值描述、注释）。
// 输出：{name, msgs: [{id, ext, name, len, tx, c?, sigs: [{n, sb, bl, bo, s, f, o, mn, mx, u, vt?, c?, mux?, fl?}]}]}
const Dbc = (() => {
  const RE_BO = /^BO_\s+(\d+)\s+(\w+)\s*:\s*(\d+)\s+(\w+)/;
  const RE_SG = /^SG_\s+(\w+)\s*(M|m\d+)?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*\(([^,]+),([^)]+)\)\s*\[([^|]*)\|([^\]]*)\]\s*"([^"]*)"/;
  const RE_CM = /CM_\s+(SG_|BO_)\s+(\d+)\s+(\w+)?\s*"((?:[^"\\]|\\.)*)"\s*;/g;
  const RE_VAL = /^VAL_\s+(\d+)\s+(\w+)\s+((?:-?\d+\s+"(?:[^"\\]|\\.)*"\s*)*);/gm;
  const RE_VALPAIR = /(-?\d+)\s+"((?:[^"\\]|\\.)*)"/g;
  const RE_LONG = /^BA_\s+"SystemSignalLongSymbol"\s+SG_\s+(\d+)\s+(\w+)\s+"([^"]+)"/gm;
  const RE_VT = /^SIG_VALTYPE_\s+(\d+)\s+(\w+)\s*:\s*([12])\s*;/gm;
  const num = s => { const v = parseFloat(s); return isNaN(v) ? 0 : v; };

  function parse(text, name) {
    const msgs = [], byId = new Map();
    let cur = null;
    for (let line of text.split(/\r?\n/)) {
      line = line.trim();
      let m = line.match(RE_BO);
      if (m) {
        const raw = Number(m[1]);
        if (raw === 0xC0000000) { cur = null; continue; }   // VECTOR__INDEPENDENT_SIG_MSG：未分配信号的占位报文
        cur = { id: raw % 0x80000000 & 0x1FFFFFFF, ext: raw >= 0x80000000 ? 1 : 0, name: m[2], len: +m[3], tx: m[4], sigs: [] };
        msgs.push(cur); byId.set(raw, cur);
        continue;
      }
      m = line.match(RE_SG);
      if (m && cur) {
        const s = { n: m[1], sb: +m[3], bl: +m[4], bo: +m[5], s: m[6] === '-' ? 1 : 0, f: num(m[7]), o: num(m[8]),
          mn: num(m[9] || 0), mx: num(m[10] || 0), u: m[11] };
        if (m[2]) s.mux = m[2] === 'M' ? 'M' : +m[2].slice(1);
        for (let k = 2; cur.sigs.some(x => x.n === s.n); k++) s.n = `${m[1]}#${k}`;   // 同一报文里信号重名，后者加 #2
        cur.sigs.push(s);
      } else if (!line) cur = null;
    }
    const sig = (mid, sn) => { const msg = byId.get(Number(mid)); return msg && msg.sigs.find(s => s.n === sn); };
    for (const m of text.matchAll(RE_CM)) {
      const t = m[4].replace(/\\"/g, '"').replace(/\r/g, '').trim();
      if (!t) continue;
      if (m[1] === 'SG_') { const s = sig(m[2], m[3]); if (s) s.c = t; }
      else if (byId.has(Number(m[2]))) byId.get(Number(m[2])).c = t;
    }
    for (const m of text.matchAll(RE_VAL)) {
      const s = sig(m[1], m[2]);
      if (s) { s.vt = {}; for (const p of m[3].matchAll(RE_VALPAIR)) s.vt[+p[1]] = p[2].split(/\s+/).filter(Boolean).join(' '); }
    }
    for (const m of text.matchAll(RE_VT)) { const s = sig(m[1], m[2]); if (s) s.fl = +m[3]; }
    for (const m of text.matchAll(RE_LONG)) { const s = sig(m[1], m[2]); if (s) s.n = m[3]; }   // 超过 32 字符的长信号名
    msgs.sort((a, b) => a.id - b.id);
    return { name, msgs };
  }

  // 中文注释多为 GBK：先试 UTF-8，不合法再按 GB18030 解码
  function decode(buf) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch (e) { return new TextDecoder('gb18030').decode(buf); }
  }

  // 多个 DBC 合并（同 ID 以后加载的为准）
  function merge(list) {
    const by = new Map();
    for (const d of list) for (const m of d.msgs) by.set((m.ext ? 'x' : '') + m.id, m);
    return { name: list.map(d => d.name).join(' + '), msgs: [...by.values()].sort((a, b) => a.id - b.id) };
  }

  return { parse, decode, merge };
})();
if (typeof module !== 'undefined') module.exports = Dbc;
