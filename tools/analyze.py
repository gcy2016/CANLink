"""报文分析（会话端用）：读 blf / asc，按车型 DBC 解析，识别故障码并对照诊断问卷，输出文字报告。

与网页“离线数据”同一套规则（docs/viewer/canlog.js），方便在对话里直接分析用户发来的报文。

依赖：pip install python-can openpyxl cryptography   （画图另需 matplotlib）
用法：
  export VEHDIAG_SRC_KEY='原始文件密码'
  python tools/analyze.py 报文.blf --model C363H                   # 概况 + 故障码 + 疑似异常信号
  python tools/analyze.py 报文.blf --model C589P高配 --find 轮速 VehicleSpeed  # 搜索信号
  python tools/analyze.py 报文.blf --model C589P高配 --sig ESP_VehicleSpeed IBCU_BrkSysFltLamp \\
         [--csv 输出.csv] [--plot 输出.png] [--t0 1.5 --t1 3]           # 信号统计 / 导出 / 画图
  python tools/analyze.py 报文.blf --dbc CIIA1.5_EV                       # 不指定车型，直接用某个 DBC
  python tools/analyze.py 报文.blf --model C589P高配 --trace 700-7FF [--t0 --t1] # 报文列表（同网页“报文提取”），诊断报文附解释
"""
import argparse, glob, io, json, os, re, struct, sys
from collections import Counter, OrderedDict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build, dbc  # noqa: E402

ROOT = build.ROOT
EXT = 0x80000000
STATUS_BITS = ['当前故障', '本次循环故障', '待定', '已确认', '清码后未完成测试', '清码后曾失败', '本循环未完成测试', '请求报警灯']
BRAKE = ('IBCU', 'ESP', 'ESC', 'EPB', 'ABS', 'IPB', 'EBB', 'EHB', 'RBM', 'BCU')


def status_text(st):
    return '、'.join(n for i, n in enumerate(STATUS_BITS) if st & (1 << i)) or '无'


def dtc_text(b1, b2, b3):
    return 'PCBU'[b1 >> 6] + f'{(b1 >> 4) & 3:X}{b1 & 15:X}{b2:02X}{b3:02X}'


# ---------- 读报文 ----------
FD_LEN = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64]


def fix_asc_line(s):
    """把某些记录仪导出的非标准 CANFD 行改成 Vector 标准格式，其他行原样返回。
    非标准：t CANFD ch id Rx|Tx brs esi d dlc(十进制) 长度 数据...
    标准：  t CANFD ch Rx|Tx id brs esi dlc(十六进制) 长度 数据..."""
    tk = s.split()
    if len(tk) < 10 or tk[1].upper() != 'CANFD' or tk[4].upper() not in ('RX', 'TX') \
            or tk[3].upper() in ('RX', 'TX'):
        return s
    tk[3], tk[4] = tk[4], tk[3]
    if tk[7].lower() == 'd' and tk[8].isdigit() and tk[9].isdigit() \
            and int(tk[8]) < 16 and FD_LEN[int(tk[8])] == int(tk[9]):
        tk[7:9] = [f'{int(tk[8]):x}']
    return ' '.join(tk) + '\n'


def open_log(path):
    import can
    if not path.lower().endswith('.asc'):
        return can.LogReader(path)
    # python-can 读文件头时会吞掉头部之后的第一行（通常是 Begin Triggerblock）；
    # 没有这一行的文件会丢第一帧，所以在第一行数据前补一行
    out, head = [], True
    with open(path, encoding='latin-1') as f:
        for s in f:
            if head and s.strip() and not re.match(r'(date|base|//)\s', s.strip(), re.I):
                head = False
                if re.match(r'\d', s.strip()):
                    out.append('Begin Triggerblock\n')
            out.append(fix_asc_line(s))
    return can.ASCReader(io.StringIO(''.join(out)))


def read_log(path):
    import can
    frames = []                                     # (t, key, ch, data)
    with open_log(path) as r:
        for m in r:
            if not isinstance(m, can.Message) or m.is_error_frame or m.is_remote_frame:
                continue
            key = (m.arbitration_id | EXT) if m.is_extended_id else m.arbitration_id
            frames.append((m.timestamp, key, m.channel, bytes(m.data), m.is_fd))
    frames.sort(key=lambda f: f[0])
    t0 = frames[0][0] if frames else 0
    return [(t - t0, k, ch, d, fd) for t, k, ch, d, fd in frames]


def by_id(frames):
    out = {}
    for i, f in enumerate(frames):
        out.setdefault(f[1], []).append(i)
    return out


# ---------- 信号解码 ----------
def raw_value(d, s):
    v = 0
    if s['bo'] == 1:
        for i in range(s['bl'] - 1, -1, -1):
            p = s['sb'] + i
            if p >> 3 >= len(d):
                return None
            v = v * 2 + ((d[p >> 3] >> (p & 7)) & 1)
    else:
        p = s['sb']
        for _ in range(s['bl']):
            if p >> 3 >= len(d):
                return None
            v = v * 2 + ((d[p >> 3] >> (p & 7)) & 1)
            p = p + 15 if p & 7 == 0 else p - 1
    if s.get('fl') == 1:
        return struct.unpack('>f', v.to_bytes(4, 'big'))[0]
    if s.get('fl') == 2:
        return struct.unpack('>d', v.to_bytes(8, 'big'))[0]
    if s['s'] and v >= 1 << (s['bl'] - 1):
        v -= 1 << s['bl']
    return v


def msg_key(m):
    return (m['id'] | EXT) if m['ext'] else m['id']


def decode(frames, idx, msg, s):
    mux = next((x for x in msg['sigs'] if x.get('mux') == 'M'), None) if isinstance(s.get('mux'), int) else None
    out = []
    for i in idx.get(msg_key(msg), []):
        t, _, _, d, _ = frames[i]
        if mux and raw_value(d, mux) != s['mux']:
            continue
        r = raw_value(d, s)
        if r is not None:
            out.append((t, r, r * s['f'] + s['o']))
    return out


# ---------- 故障码 ----------
def is_diag(k):
    return (not k & EXT and 0x700 <= k <= 0x7FF) or (k & EXT and (k & 0x1FFF0000) >> 16 == 0x18DA)


def isotp(frames, idx):
    out = []
    for k, ii in idx.items():
        if not is_diag(k):
            continue
        st = {}
        for i in ii:
            t, _, ch, d, _ = frames[i]
            if not d:
                continue
            typ = d[0] >> 4
            if typ == 0:
                n, s = d[0] & 15, 1
                if n == 0 and len(d) > 8:
                    n, s = d[1], 2
                if n and s + n <= len(d):
                    out.append((t, k, d[s:s + n]))
                st.pop(ch, None)
            elif typ == 1:
                n, s = ((d[0] & 15) << 8) | d[1], 2
                if n == 0:
                    n, s = int.from_bytes(d[2:6], 'big'), 6
                if 0 < n < 1 << 20:
                    st[ch] = [t, bytearray(d[s:s + n]), n, 1]
            elif typ == 2 and ch in st:
                x = st[ch]
                if d[0] & 15 != x[3] & 15:
                    st.pop(ch)
                    continue
                x[1] += d[1:1 + x[2] - len(x[1])]
                x[3] += 1
                if len(x[1]) >= x[2]:
                    out.append((x[0], k, bytes(x[1])))
                    st.pop(ch)
    return sorted(out, key=lambda x: x[0])


def find_dtcs(frames, idx, db):
    found, events = OrderedDict(), []
    tx = {msg_key(m): m['tx'] for m in db['msgs']} if db else {}

    def add(b1, b2, b3, st, src, ecu, t):
        if not (b1 | b2 | b3):
            return
        code = dtc_text(b1, b2, b3)
        x = found.get(ecu + code)
        if x:
            x['st'] |= st; x['n'] += 1; x['tl'] = t
        else:
            found[ecu + code] = {'code': code, 'b': f'{b1:02X}{b2:02X} {b3:02X}', 'st': st, 'src': src, 'ecu': ecu, 't': t, 'tl': t, 'n': 1}

    for t, k, p in isotp(frames, idx):
        ecu = tx.get(k, f'0x{k & 0x1FFFFFFF:X}')
        if p[0] == 0x59 and len(p) > 1 and p[1] in (0x02, 0x0A, 0x0F, 0x13, 0x15):
            for i in range(3, len(p) - 3, 4):
                if p[1] != 0x0A or p[i + 3] & 0x0D:
                    add(p[i], p[i + 1], p[i + 2], p[i + 3], f'诊断应答 19 {p[1]:02X}', ecu, t)
            events.append((t, ecu, f'读故障码应答（19 {p[1]:02X}），{max(0, (len(p) - 3) // 4)} 条'))
        elif p[0] == 0x59 and len(p) >= 6 and p[1] in (0x04, 0x06):
            add(p[2], p[3], p[4], p[5], f'诊断应答 19 {p[1]:02X}', ecu, t)
        elif p[0] == 0x54:
            events.append((t, ecu, '清除故障码成功（14 服务）'))
        elif p[0] == 0x7F and len(p) > 2 and p[1] == 0x19:
            events.append((t, ecu, f'读故障码被拒绝，否定码 0x{p[2]:02X}'))
    import re
    for m in (db['msgs'] if db else []):
        groups = {}
        for s in m['sigs']:
            g = re.match(r'^(.*?)_?(High|Midd|Middle|Mid|Low)_?Byte$', s['n'], re.I) or re.match(r'^(.*DTC\d*)_?(Status|Sts)$', s['n'], re.I)
            if g:
                groups.setdefault(g[1], {})['m' if g[2].lower()[0] == 'm' else g[2].lower()[0]] = s
        for g, x in groups.items():
            if not all(k in x for k in 'hml'):
                continue
            for i in idx.get(msg_key(m), []):
                t, _, _, d, _ = frames[i]
                h, md, lo = (raw_value(d, x[k]) for k in 'hml')
                if None in (h, md, lo):
                    continue
                add(h, md, lo, (raw_value(d, x['s']) or 0) if 's' in x else 0, '广播信号 ' + g, m['tx'], t)
    return sorted(found.values(), key=lambda x: x['t']), events


CAND = r'fail|fault|flt|err|warn|lamp|light|malfunc|invalid|defect|abnormal|故障|失效|错误|报警|异常|指示灯'
BADV = r'fail|fault|err|warn|malfunc|invalid|defect|abnormal|故障|失效|错误|报警|异常'
ONV = r'^on$|\bon\b|active|request|blink|flash|点亮|亮|闪'
OKV = r'\bno\b|\bnot\b|normal|^no|none|无|正常|未|inactive|\boff\b|\bok\b|^valid|reserved|init'


def suspects(frames, idx, db):
    import re
    out = []
    for m in db['msgs'] if db else []:
        if msg_key(m) not in idx:
            continue
        for s in m['sigs']:
            if not s.get('vt') or not re.search(CAND, s['n'] + ' ' + s.get('c', ''), re.I):
                continue
            seen = {}
            for t, r, _ in decode(frames, idx, m, s):
                seen.setdefault(r, t)
            for r, t in seen.items():
                txt = s['vt'].get(r)
                if txt is None or re.search(OKV, txt, re.I):
                    continue
                if re.search(BADV, txt, re.I) or (re.search(r'lamp|light|warn|indicat|报警|灯', s['n'], re.I) and re.search(ONV, txt, re.I)):
                    out.append((t, m['name'], s['n'], r, txt))
    return sorted(out)


# ---------- 报文列表 ----------
UDS = json.load(open(os.path.join(ROOT, 'tools', 'uds.json'), encoding='utf-8'))


def uds_brief(p):
    """诊断报文简要解释（完整解释见网页 canlog.js 的 udsExplain，规则表共用 tools/uds.json）"""
    if not p:
        return ''
    sv = UDS['services']
    if p[0] == 0x7F and len(p) >= 3:
        n = UDS['nrc'].get(f'{p[2]:02X}', ['未定义的否定码', ''])
        return f"否定响应：0x{p[1]:02X} {sv.get(f'{p[1]:02X}', '')} 被拒，NRC 0x{p[2]:02X} {n[0]}" + (f'（{n[1]}）' if n[1] else '')
    k = f'{p[0]:02X}'
    if k in sv:
        return f'请求 0x{k} {sv[k]}'
    if f'{p[0] - 0x40:02X}' in sv:
        return f"正响应 0x{p[0] - 0x40:02X} {sv[f'{p[0] - 0x40:02X}']}"
    return ''


def trace(frames, idx, db, a):
    import re
    names = {msg_key(m): m['name'] for m in db['msgs']} if db else {}
    keep = None
    if a.trace:
        keep = set()
        for k in idx:
            raw, nm = k & 0x1FFFFFFF, names.get(k, '').lower()
            for t in a.trace:
                r = re.fullmatch(r'(?:0x)?([0-9a-f]+)-(?:0x)?([0-9a-f]+)', t, re.I)
                h = re.fullmatch(r'(?:0x)?([0-9a-f]+)x?', t, re.I)
                if (r and int(r[1], 16) <= raw <= int(r[2], 16)) or (h and raw == int(h[1], 16)) or (nm and t.lower() in nm):
                    keep.add(k)
    done = {}
    for t, k, p in isotp(frames, idx):
        done.setdefault(k, []).append((t, p))
    print('\n# 报文列表')
    n = 0
    for t, k, ch, d, fd in frames:
        if keep is not None and k not in keep:
            continue
        if (a.t0 is not None and t < a.t0) or (a.t1 is not None and t > a.t1):
            continue
        line = f"{t:11.6f}  CAN{(ch or 0) + 1}  0x{k & 0x1FFFFFFF:X}{'x' if k & EXT else ''}  {names.get(k, ''):<16} {len(d):>2}{' FD' if fd else '   '}  {d.hex(' ').upper()}"
        if is_diag(k):
            hit = next((p for tt, p in done.get(k, []) if abs(tt - t) < 1e-9), None)
            if hit is not None:
                line += f"   ← {hit.hex(' ').upper() if len(hit) > len(d) - 1 else ''} {uds_brief(hit)}"
        print(line)
        n += 1
        if n >= a.limit:
            print(f'…（只显示前 {a.limit} 行，用 --limit 调整）')
            break


# ---------- 数据 ----------
def load_data(key):
    src = os.path.join(ROOT, 'source')
    dbcs = {}
    for f in sorted(glob.glob(os.path.join(src, '*.dbc.enc'))):
        name = os.path.basename(f)[:-8]
        dbcs[name] = dbc.load_bytes(build.open_file(open(f, 'rb').read(), key), name)
    zh_map = json.load(open(os.path.join(ROOT, 'tools', 'zh_map.json'), encoding='utf-8'))
    models = []
    for f in sorted(glob.glob(os.path.join(src, '*.xlsx.enc'))):
        models += build.load(io.BytesIO(build.open_file(open(f, 'rb').read(), key)), zh_map)
    return dbcs, {m['model']: m for m in models}


def fmt_v(v):
    return f'{v:.6g}' if isinstance(v, float) else str(v)


def main():
    ap = argparse.ArgumentParser(description='报文分析')
    ap.add_argument('log')
    ap.add_argument('--src-key', default=os.environ.get('VEHDIAG_SRC_KEY'))
    ap.add_argument('--model', help='车型（项目代号如 C363H，或问卷 Sheet 名），决定 DBC 和诊断问卷')
    ap.add_argument('--dbc', help='直接指定 DBC 名，覆盖车型的默认 DBC')
    ap.add_argument('--find', nargs='+', metavar='关键词', help='搜索信号（名称 / 报文名 / 注释）')
    ap.add_argument('--sig', nargs='+', metavar='信号', help='输出这些信号的统计和变化')
    ap.add_argument('--t0', type=float, default=None)
    ap.add_argument('--t1', type=float, default=None)
    ap.add_argument('--trace', nargs='*', metavar='ID', help='列出报文：ID / 范围 700-7FF / 报文名，不填为全部')
    ap.add_argument('--limit', type=int, default=500, help='--trace 最多输出行数')
    ap.add_argument('--csv', help='把 --sig 的信号导出为 CSV')
    ap.add_argument('--plot', help='把 --sig 的信号画成 PNG（每个信号一个子图）')
    a = ap.parse_args()
    if not a.src_key:
        ap.error('需要原始文件密码 --src-key（或环境变量 VEHDIAG_SRC_KEY）')
    if a.model:
        a.model = build.market_name(a.model)
    dbcs, models = load_data(a.src_key)
    dbc_map = json.load(open(os.path.join(ROOT, 'tools', 'dbc_map.json'), encoding='utf-8'))
    model = models.get(a.model) if a.model else None
    if a.model and not model:
        sys.exit('没有这个车型，可选：' + '、'.join(f'{build.code_name(k)}（{k}）' for k in models))
    db = dbcs.get(a.dbc or (dbc_map.get(a.model) if a.model else ''))

    frames = read_log(a.log)
    idx = by_id(frames)
    n = len(frames)
    dur = frames[-1][0] if frames else 0
    print(f'# 报文概况\n文件 {os.path.basename(a.log)}；时长 {dur:.3f} s；{n} 帧（FD {sum(f[4] for f in frames)}）；'
          f'{len(idx)} 个 ID；通道 ' + ' '.join(f'CAN{(c or 0) + 1}' for c in sorted(Counter(f[2] for f in frames), key=str)))
    print('各 DBC 覆盖率：' + '；'.join(
        f"{k} {sum(len(idx.get(msg_key(m), [])) for m in v['msgs']) / max(n, 1):.0%}" for k, v in dbcs.items()))
    if not db:
        best = max(dbcs, key=lambda k: sum(len(idx.get(msg_key(m), [])) for m in dbcs[k]['msgs']))
        print(f'未指定车型 / DBC，按覆盖率自动选用 {best}')
        db = dbcs[best]
    print(f"使用 DBC：{db['name']}" + (f"；车型：{build.code_name(model['model'])}（{model['model']}）" if model else '（未指定车型，不对照问卷）'))
    known = {msg_key(m) for m in db['msgs']}
    unk = sorted(k for k in idx if k not in known)
    if unk:
        print('DBC 未定义的 ID：' + '、'.join(f'0x{k & 0x1FFFFFFF:X}({len(idx[k])})' for k in unk))

    msgs = {m['name']: m for m in db['msgs']}
    allsig = [(m, s) for m in db['msgs'] for s in m['sigs']]

    if a.find:
        print('\n# 信号搜索')
        for m, s in allsig:
            text = (s['n'] + ' ' + m['name'] + ' ' + s.get('c', '')).lower()
            if all(w.lower() in text for w in a.find):
                print(f"- {s['n']} [{s['u']}]  报文 {m['name']}（{len(idx.get(msg_key(m), []))} 帧）  {s.get('c', '')[:60]!r}")
        return

    if a.trace is not None:
        trace(frames, idx, db, a)
        return

    if a.sig:
        print('\n# 信号')
        rows = {}
        for name in a.sig:
            hits = [(m, s) for m, s in allsig if s['n'] == name or f"{m['name']}.{s['n']}" == name]
            if not hits:
                print(f'- {name}：DBC 中没有这个信号')
                continue
            m, s = max(hits, key=lambda x: len(idx.get(msg_key(x[0]), [])))
            data = [x for x in decode(frames, idx, m, s)
                    if (a.t0 is None or x[0] >= a.t0) and (a.t1 is None or x[0] <= a.t1)]
            rows[s['n']] = (s, data)
            if not data:
                print(f"- {s['n']}（{m['name']}）：报文中没有数据")
                continue
            vs = [x[2] for x in data]
            print(f"- {s['n']} [{s['u']}]（{m['name']}，{len(data)} 点）：最小 {fmt_v(min(vs))}  最大 {fmt_v(max(vs))}  "
                  f"平均 {fmt_v(sum(vs) / len(vs))}  首 {fmt_v(vs[0])}  末 {fmt_v(vs[-1])}")
            ch, last = [], object()
            for t, r, v in data:
                if r != last:
                    ch.append((t, r, v)); last = r
            if len(ch) <= 30:
                print('  变化：' + '；'.join(f"{t:.3f}s→{fmt_v(v)}" + (f"({s['vt'][r]})" if s.get('vt', {}).get(r) else '') for t, r, v in ch))
            else:
                print(f'  共变化 {len(ch) - 1} 次')
        if a.csv:
            import csv
            with open(a.csv, 'w', newline='', encoding='utf-8-sig') as f:
                w = csv.writer(f)
                w.writerow(['信号', '时间s', '原始值', '物理值', '描述'])
                for nm, (s, data) in rows.items():
                    for t, r, v in data:
                        w.writerow([nm, f'{t:.6f}', r, v, s.get('vt', {}).get(r, '')])
            print('已导出', a.csv)
        if a.plot and rows:
            import matplotlib
            matplotlib.use('Agg')
            import matplotlib.pyplot as plt
            plt.rcParams['font.sans-serif'] = ['Noto Sans CJK SC', 'Microsoft YaHei', 'SimHei', 'DejaVu Sans']
            fig, axs = plt.subplots(len(rows), 1, sharex=True, figsize=(12, 2.2 * len(rows)), squeeze=False)
            for ax, (nm, (s, data)) in zip(axs[:, 0], rows.items()):
                if data:
                    ax.step([x[0] for x in data], [x[2] for x in data], where='post', lw=1)
                ax.set_ylabel(f"{nm}\n[{s['u']}]" if s['u'] else nm, fontsize=8)
                ax.grid(alpha=.3)
            axs[-1, 0].set_xlabel('t (s)')
            fig.tight_layout()
            fig.savefig(a.plot, dpi=110)
            print('已画图', a.plot)
        return

    print('\n# 故障码')
    dtcs, events = find_dtcs(frames, idx, db)
    items = {it['d']: it for it in model['items']} if model else {}
    if not dtcs:
        print('报文中没有发现故障码（没有诊断仪读码应答，也没有广播的故障码信号）')
    for d in dtcs:
        st = status_text(d['st']) if d['src'].startswith('诊断') else ''
        print(f"- {d['code']}（{d['b']}）{d['ecu']} · {d['src']} · 状态 0x{d['st']:02X} {st} · 首次 {d['t']:.3f}s"
              + (f" · 共 {d['n']} 次" if d['n'] > 1 else ''))
        it = items.get(d['code'])
        if it:
            note = '' if any(b in d['ecu'].upper() for b in BRAKE) else '（来自非制动模块，仅供参考）'
            print(f"  问卷{note}：{it.get('desc', '')}\n  可能原因：{it.get('cause', '')}\n  维修建议：{it.get('fix', '')}")
        elif model:
            print('  问卷中未收录')
    for t, ecu, txt in events:
        print(f'  {t:.3f}s {ecu} {txt}')

    print('\n# 疑似异常的状态信号')
    sus = suspects(frames, idx, db)
    if not sus:
        print('无')
    for t, mn, sn, r, txt in sus:
        print(f'- {t:.3f}s {sn}（{mn}）= {r} {txt}')


if __name__ == '__main__':
    main()
