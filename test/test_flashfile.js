// 刷写文件解析自测：Intel HEX、Motorola S19、原始 bin，以及段合并和校验和检查。
const assert = require('assert');
const FF = require('../docs/flashfile.js');
let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('✓', m); pass++; };
const hx = a => Array.from(a, b => b.toString(16).toUpperCase().padStart(2, '0')).join('');

// Intel HEX：两条数据（0x0000 和 0x0004，中间有缺口）+ 扩展线性地址 + EOF
{
  // :04 0000 00 01020304 F2 ; :04 0010 00 05060708 D2 ; :00 0000 01 FF
  const hex = [':0400000001020304F2', ':0400100005060708D2', ':00000001FF'].join('\n');
  const r = FF.parse(hex);
  ok(r.type === 'hex', 'HEX 识别');
  ok(r.segs.length === 2, 'HEX 两段（中间有缺口）');
  ok(r.segs[0].addr === 0 && hx(r.segs[0].data) === '01020304', '第一段地址/数据');
  ok(r.segs[1].addr === 0x10 && hx(r.segs[1].data) === '05060708', '第二段地址/数据');
  ok(FF.total(r.segs) === 8, '总字节数');
}
// HEX 扩展线性地址 04
{
  const hex = [':020000040800F2', ':040000001122334452', ':00000001FF'].join('\n');
  const r = FF.parse(hex);
  ok(r.segs[0].addr === 0x08000000 && hx(r.segs[0].data) === '11223344', 'HEX 04 扩展线性地址生效（0x08000000）');
}
// HEX 校验和错应报错
{
  let threw = false;
  try { FF.parse(':0400000001020304FF\n:00000001FF'); } catch (e) { threw = /校验和/.test(e.message); }
  ok(threw, 'HEX 校验和错能报出来');
}

// S19：S1 记录，相邻两段合并成一段
{
  // S1 地址 0000 数据 0102 ; 地址 0002 数据 0304（相邻→合并）
  const mk = (addr, data) => { const body = ((data.length / 2 + 2 + 1)).toString(16).padStart(2, '0') + addr + data; let s = 0; for (let i = 0; i < body.length; i += 2) s = (s + parseInt(body.substr(i, 2), 16)) & 0xFF; return 'S1' + body + ((~s) & 0xFF).toString(16).padStart(2, '0'); };
  const s19 = ['S00600004844521B', mk('0000', '0102'), mk('0002', '0304'), 'S5030002FA', 'S9030000FC'].join('\n');
  const r = FF.parse(s19);
  ok(r.type === 's19', 'S19 识别');
  ok(r.segs.length === 1 && hx(r.segs[0].data) === '01020304', 'S19 相邻段合并');
}
// S19 S3（32 位地址）
{
  const mk3 = (addr, data) => { const body = ((data.length / 2 + 4 + 1)).toString(16).padStart(2, '0') + addr + data; let s = 0; for (let i = 0; i < body.length; i += 2) s = (s + parseInt(body.substr(i, 2), 16)) & 0xFF; return 'S3' + body + ((~s) & 0xFF).toString(16).padStart(2, '0'); };
  const r = FF.parse([mk3('08000000', 'AABBCCDD'), 'S70508000000F2'].join('\n'));
  ok(r.segs[0].addr === 0x08000000 && hx(r.segs[0].data) === 'AABBCCDD', 'S19 S3 32 位地址');
}

// 原始 bin
{
  const r = FF.parse(new Uint8Array([1, 2, 3, 4]), undefined, 0x08000000);
  ok(r.type === 'bin' && r.segs[0].addr === 0x08000000 && hx(r.segs[0].data) === '01020304', 'bin：给定起始地址');
}

// 界面选文件：扩展名 / 内容不对都要拒绝
{
  const hex = [':0400000001020304F2', ':00000001FF'].join('\n');
  ok(FF.parseFile('app.hex', hex).type === 'hex', 'parseFile：.hex 接收');
  for (const [name, text, kw] of [
    ['app.bin', 'hello', '只支持'],
    ['app.hex', 'hello', '不是 S19'],
    ['app.txt', hex, '只支持'],
    ['app.hex', '\u0000\u0001\u0002', '二进制'],
  ]) {
    let msg = '';
    try { FF.parseFile(name, text); } catch (e) { msg = e.message; }
    ok(msg.includes(kw), `parseFile：${name} 拒绝（${kw}）`);
  }
}

console.log(`\n全部通过（${pass} 项）`);
