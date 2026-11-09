// 诊断问卷（Excel）解析：每个 Sheet = 一份问卷（通常对应一个车型 / 配置）。
// 表头行需含 “DTC Number”（显示码）、“Faults Types”（故障描述）、“Possible Fault”（可能原因）、“Corrective”（维修建议）；
// 显示码右边两列为高中字节、低字节；描述类每项占两列（中文、英文）。只取中文。返回 [{model, items: [{d, hm, l, desc, cause, fix}]}]
const Qn = (() => {
  const CJK = /[一-鿿]/;
  const cell = v => v === null || v === undefined ? '' : String(v).replace(/\r\n?/g, '\n').trim();
  const hexbyte = (v, w) => { v = v.toUpperCase().replace(/ /g, '').replace(/^0X/, ''); return /^[0-9A-F]+$/.test(v) ? v.padStart(w, '0') : v; };
  const zh = (cn, en) => !CJK.test(cn) && CJK.test(en) ? en : cn;   // 中英文栏填反时取中文那栏
  const KEYS = { d: /DTC\s*Number|显示码/i, desc: /Faults?\s*Types?|故障描述/i, cause: /Possible\s*Fault|可能原因/i, fix: /Corrective|维修建议|维修措施/i };

  function sheet(rows, name) {
    let hi = -1, col = {};
    for (let r = 0; r < Math.min(rows.length, 15) && hi < 0; r++) {
      const c = {};
      (rows[r] || []).forEach((v, i) => { for (const [k, re] of Object.entries(KEYS)) if (c[k] === undefined && re.test(cell(v))) c[k] = i; });
      if (c.d !== undefined) { hi = r; col = c; }
    }
    if (hi < 0) return null;
    const items = [];
    for (const r of rows.slice(hi + 1)) {
      if (!r) continue;
      const d = cell(r[col.d]).toUpperCase();
      if (!/^[PCBU][0-9A-F]{6}$/.test(d)) continue;
      const it = { d, hm: hexbyte(cell(r[col.d + 1]), 4), l: hexbyte(cell(r[col.d + 2]), 2) };
      for (const k of ['desc', 'cause', 'fix']) {
        if (col[k] === undefined) continue;
        it[k] = zh(cell(r[col[k]]), cell(r[col[k] + 1]));
      }
      items.push(it);
    }
    return items.length ? { model: name, items } : null;
  }

  // buf: ArrayBuffer；需要先加载 lib/xlsx.full.min.js（全局 XLSX）
  function parse(buf) {
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
    return wb.SheetNames.map(n => sheet(XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null, raw: true }), n)).filter(Boolean);
  }
  return { parse };
})();
if (typeof module !== 'undefined') module.exports = Qn;
