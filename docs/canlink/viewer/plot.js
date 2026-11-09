// 多信号曲线（类似 CANalyzer Graphics）：每个信号一条泳道、各自 Y 轴，从上往下均分高度，共用时间轴。
// 滚轮 / 双指缩放时间轴，拖动平移，双击复位；鼠标悬停显示各信号当前值。
const Plot = (() => {
  const COLORS = ['#2a6db5', '#d93025', '#0f9d58', '#e37400', '#8e24aa', '#00838f', '#c2185b', '#5d4037', '#3949ab', '#7cb342'];
  const AXIS_W = 70, XAXIS_H = 26, PAD = 6;

  function niceStep(span, n) {
    const raw = span / Math.max(1, n), p = 10 ** Math.floor(Math.log10(raw)), r = raw / p;
    return (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * p;
  }
  const fmt = (v, step) => {
    const d = Math.max(0, Math.min(6, -Math.floor(Math.log10(step || 1) + 1e-9)));
    return Number(v.toFixed(d)).toString();
  };
  // 二分：第一个 t[i] >= x
  function lower(t, x) {
    let lo = 0, hi = t.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m; }
    return lo;
  }

  class Plot {
    constructor(box, onChange) {
      this.box = box; this.onChange = onChange;
      this.cv = document.createElement('canvas');
      this.cv.style.cssText = 'display:block;width:100%;touch-action:none;cursor:grab';
      box.appendChild(this.cv);
      this.ctx = this.cv.getContext('2d');
      this.sigs = []; this.x0 = 0; this.x1 = 1; this.full = [0, 1]; this.hover = null; this.height = 0;
      this.bind();
      new ResizeObserver(() => this.draw()).observe(box);
    }

    // sigs: [{key, name, unit, t, v, vt, step}]
    set(sigs, dur, keepView) {
      sigs.forEach((s, i) => { s.color = s.color || COLORS[i % COLORS.length]; });
      this.sigs = sigs;
      this.full = [0, Math.max(dur, 1e-3)];
      if (!keepView) [this.x0, this.x1] = this.full;
      this.draw();
    }
    reset() { [this.x0, this.x1] = this.full; this.draw(); }
    zoom(f, cx) {                                      // f<1 放大；cx 为缩放中心（时间）
      const c = cx ?? (this.x0 + this.x1) / 2, [a, b] = this.full;
      let w = Math.min(b - a, Math.max(1e-5, (this.x1 - this.x0) * f));
      let x0 = c - (c - this.x0) * w / (this.x1 - this.x0);
      x0 = Math.max(a, Math.min(b - w, x0));
      this.x0 = x0; this.x1 = x0 + w; this.draw();
    }
    pan(dt) {
      const [a, b] = this.full, w = this.x1 - this.x0;
      this.x0 = Math.max(a, Math.min(b - w, this.x0 + dt)); this.x1 = this.x0 + w; this.draw();
    }
    setHeight(h) { this.height = h; this.draw(); }

    geom() {
      const W = this.box.clientWidth, n = Math.max(1, this.sigs.length);
      const H = this.height || Math.max(320, Math.min(window.innerHeight * 0.72, 90 + n * 150));
      return { W, H, n, laneH: (H - XAXIS_H) / n, pw: W - AXIS_W - PAD };
    }
    tx(t, g) { return AXIS_W + (t - this.x0) / (this.x1 - this.x0) * g.pw; }
    xt(x, g) { return this.x0 + (x - AXIS_W) / g.pw * (this.x1 - this.x0); }

    draw() {
      const g = this.geom(), dpr = window.devicePixelRatio || 1, c = this.ctx;
      if (!g.W) return;
      this.cv.style.height = g.H + 'px';
      if (this.cv.width !== Math.round(g.W * dpr) || this.cv.height !== Math.round(g.H * dpr)) {
        this.cv.width = Math.round(g.W * dpr); this.cv.height = Math.round(g.H * dpr);
      }
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, g.W, g.H);
      c.font = '11px -apple-system, "Microsoft YaHei", sans-serif';
      if (!this.sigs.length) {
        c.fillStyle = '#6b7280'; c.textAlign = 'center';
        c.fillText('在上方搜索并添加信号', g.W / 2, g.H / 2);
        return;
      }
      // 时间网格
      const xs = niceStep(this.x1 - this.x0, Math.max(2, g.pw / 90));
      c.strokeStyle = '#eef1f5'; c.lineWidth = 1; c.beginPath();
      for (let t = Math.ceil(this.x0 / xs) * xs; t <= this.x1; t += xs) {
        const x = Math.round(this.tx(t, g)) + .5; c.moveTo(x, 0); c.lineTo(x, g.H - XAXIS_H);
      }
      c.stroke();
      this.sigs.forEach((s, i) => this.lane(s, i, g));
      // 时间轴
      c.fillStyle = '#6b7280'; c.textAlign = 'center'; c.textBaseline = 'top';
      for (let t = Math.ceil(this.x0 / xs) * xs; t <= this.x1; t += xs) c.fillText(fmt(t, xs) + 's', this.tx(t, g), g.H - XAXIS_H + 6);
      c.strokeStyle = '#9aa5b4'; c.beginPath(); c.moveTo(AXIS_W, g.H - XAXIS_H + .5); c.lineTo(g.W - PAD, g.H - XAXIS_H + .5); c.stroke();
      // 光标
      if (this.hover !== null) {
        const x = Math.round(this.tx(this.hover, g)) + .5;
        c.strokeStyle = 'rgba(0,0,0,.45)'; c.setLineDash([4, 3]); c.beginPath(); c.moveTo(x, 0); c.lineTo(x, g.H - XAXIS_H); c.stroke(); c.setLineDash([]);
        const lbl = this.hover.toFixed(4) + 's', w = c.measureText(lbl).width + 8;
        c.fillStyle = '#1f2937'; c.fillRect(Math.min(x - w / 2, g.W - w), g.H - XAXIS_H + 2, w, 18);
        c.fillStyle = '#fff'; c.textBaseline = 'middle'; c.fillText(lbl, Math.min(x, g.W - w / 2), g.H - XAXIS_H + 11);
      }
    }

    lane(s, i, g) {
      const c = this.ctx, top = i * g.laneH, h = g.laneH, y0 = top + 16, y1 = top + h - 6;
      if (i) { c.strokeStyle = '#d5dde8'; c.beginPath(); c.moveTo(0, top + .5); c.lineTo(g.W, top + .5); c.stroke(); }
      const a = Math.max(0, lower(s.t, this.x0) - 1), b = Math.min(s.t.length, lower(s.t, this.x1) + 1);
      let mn = Infinity, mx = -Infinity;
      for (let k = a; k < b; k++) { const v = s.v[k]; if (v < mn) mn = v; if (v > mx) mx = v; }
      if (!isFinite(mn)) { mn = 0; mx = 1; }
      if (mn === mx) { mn -= 1; mx += 1; } else { const p = (mx - mn) * .08; mn -= p; mx += p; }
      const ty = v => y1 - (v - mn) / (mx - mn) * (y1 - y0);
      // Y 轴刻度
      const ys = niceStep(mx - mn, Math.max(1, Math.floor((y1 - y0) / 28)));
      c.textAlign = 'right'; c.textBaseline = 'middle';
      for (let v = Math.ceil(mn / ys) * ys; v <= mx; v += ys) {
        const y = Math.round(ty(v)) + .5;
        c.strokeStyle = '#f1f3f6'; c.beginPath(); c.moveTo(AXIS_W, y); c.lineTo(g.W - PAD, y); c.stroke();
        c.fillStyle = '#6b7280'; c.fillText(fmt(v, ys), AXIS_W - 6, y);
      }
      c.strokeStyle = s.color; c.lineWidth = 2; c.beginPath(); c.moveTo(AXIS_W - .5, y0 - 4); c.lineTo(AXIS_W - .5, y1 + 2); c.stroke();
      // 曲线：点多时每个像素列取最小/最大值
      c.save(); c.beginPath(); c.rect(AXIS_W, top + 1, g.pw, h - 1); c.clip();
      c.strokeStyle = s.color; c.lineWidth = 1.4; c.beginPath();
      if (b - a > g.pw * 3) {
        let col = -1, cmn = 0, cmx = 0, first = true;
        const flush = () => {
          if (col < 0) return;
          const x = AXIS_W + col + .5;
          if (first) { c.moveTo(x, ty(cmn)); first = false; } else c.lineTo(x, ty(cmn));
          c.lineTo(x, ty(cmx));
        };
        for (let k = a; k < b; k++) {
          const cc = Math.floor(this.tx(s.t[k], g) - AXIS_W), v = s.v[k];
          if (cc !== col) { flush(); col = cc; cmn = cmx = v; } else { if (v < cmn) cmn = v; if (v > cmx) cmx = v; }
        }
        flush();
      } else {
        for (let k = a; k < b; k++) {
          const x = this.tx(s.t[k], g), y = ty(s.v[k]);
          if (k === a) c.moveTo(x, y);
          else if (s.step) { c.lineTo(x, ty(s.v[k - 1])); c.lineTo(x, y); } else c.lineTo(x, y);
        }
        if (s.step && b > a) c.lineTo(this.tx(Math.min(this.x1, s.t[b - 1] + (this.x1 - this.x0)), g), ty(s.v[b - 1]));
      }
      c.stroke();
      if (b - a <= g.pw / 6) {                          // 点稀疏时画出采样点
        c.fillStyle = s.color;
        for (let k = a; k < b; k++) c.fillRect(this.tx(s.t[k], g) - 1.5, ty(s.v[k]) - 1.5, 3, 3);
      }
      c.restore();
      // 名称 + 光标值
      let label = s.name + (s.unit ? ` [${s.unit}]` : '');
      if (this.hover !== null && s.t.length) {
        const k = Math.max(0, lower(s.t, this.hover + 1e-9) - 1), v = s.v[k], r = s.raw ? s.raw[k] : v;
        label += ' = ' + (Number.isInteger(v) ? v : Number(v.toPrecision(7))) + (s.vt && s.vt[r] !== undefined ? ` (${s.vt[r]})` : '');
      }
      c.font = 'bold 12px -apple-system, "Microsoft YaHei", sans-serif';
      c.textAlign = 'left'; c.textBaseline = 'top';
      const w = c.measureText(label).width;
      c.fillStyle = 'rgba(255,255,255,.85)'; c.fillRect(AXIS_W + 4, top + 2, w + 8, 16);
      c.fillStyle = s.color; c.fillText(label, AXIS_W + 8, top + 3);
      c.font = '11px -apple-system, "Microsoft YaHei", sans-serif';
    }

    bind() {
      const cv = this.cv, pt = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
      cv.addEventListener('wheel', e => {
        if (!this.sigs.length) return;
        e.preventDefault();
        const g = this.geom(), [x] = pt(e);
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) this.pan(e.deltaX / g.pw * (this.x1 - this.x0));
        else this.zoom(Math.exp(e.deltaY * 0.0015), this.xt(Math.max(AXIS_W, x), g));
      }, { passive: false });
      const ptrs = new Map();
      let drag = null, pinch = null;
      cv.addEventListener('pointerdown', e => {
        cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, pt(e));
        if (ptrs.size === 1) { drag = { x: pt(e)[0], x0: this.x0 }; cv.style.cursor = 'grabbing'; }
        if (ptrs.size === 2) {
          const [p, q] = [...ptrs.values()];
          pinch = { d: Math.abs(p[0] - q[0]) || 1, c: this.xt((p[0] + q[0]) / 2, this.geom()), x0: this.x0, x1: this.x1 };
          drag = null;
        }
      });
      cv.addEventListener('pointermove', e => {
        const g = this.geom(), [x] = pt(e);
        if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, pt(e));
        if (pinch && ptrs.size === 2) {
          const [p, q] = [...ptrs.values()], f = pinch.d / (Math.abs(p[0] - q[0]) || 1);
          this.x0 = pinch.x0; this.x1 = pinch.x1; this.zoom(f, pinch.c); return;
        }
        if (drag) {
          const w = this.x1 - this.x0;
          this.x0 = drag.x0; this.x1 = drag.x0 + w;
          this.pan(-(x - drag.x) / g.pw * w);
        }
        this.hover = x >= AXIS_W && this.sigs.length ? this.xt(x, g) : null;
        this.draw();
      });
      const up = e => {
        ptrs.delete(e.pointerId);
        if (ptrs.size < 2) pinch = null;
        if (!ptrs.size) { drag = null; cv.style.cursor = 'grab'; }
      };
      cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
      cv.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { this.hover = null; this.draw(); } });
      cv.addEventListener('dblclick', () => this.reset());
    }
  }
  return Plot;
})();
