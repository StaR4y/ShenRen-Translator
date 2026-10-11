// 波形条：画出波形和时间刻度，用两个可拖动的把手选出要保留的一段。

const BAR = 3; // 每根柱子占的像素（含 1px 间隙）
export const RULER = 18; // 底部时间刻度的高度
const STEPS = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

export const cssVars = el => {
  const css = getComputedStyle(el);
  return name => css.getPropertyValue(name).trim();
};

/** 在 y 处画一条时间刻度，并在 top..y 之间画淡淡的竖向网格线。显示的是 from 起、长 span 秒的一段。 */
export function drawRuler(g, color, { x0 = 0, width, top = 0, y, span, from = 0 }) {
  const step = STEPS.find(s => (s / span) * width >= 56) ?? STEPS.at(-1);
  const label = t =>
    step < 1 ? `${t.toFixed(step < 0.1 ? 2 : 1)}s` : `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
  g.font = `10px ${color('--mono')}`;
  g.textBaseline = 'top';
  for (let i = Math.ceil(from / step - 1e-6); i * step <= from + span + 1e-6; i++) {
    const x = Math.round(x0 + ((i * step - from) / span) * width);
    g.fillStyle = color('--grid');
    g.fillRect(x, top, 1, y - top + 5);
    const text = label(i * step);
    if (x + 4 + g.measureText(text).width > x0 + width) continue;
    g.fillStyle = color('--muted');
    g.fillText(text, x + 4, y + 5);
  }
}

export function setupCanvas(canvas, width, height) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  return g;
}

export class Wave {
  /**
   * @param el 内含 <canvas> 和两个 .handle 的容器
   * @param onChange(final) 选区变化时调用，拖动过程中 final 为 false
   * @param onSeek(seconds) 点击波形时调用
   * @param ruler 是否在底部画时间刻度
   */
  constructor(el, { onChange, onSeek, ruler = true }) {
    this.el = el;
    this.rulerHeight = ruler ? RULER : 0;
    this.reference = null; // 波形高度按这个峰值来定；不设就按自己的最大值撑满
    this.clip = null; // { a, b }：选区还要再落在这个范围内才算数（各轨的波形受整首选区限制）
    this.canvas = el.querySelector('canvas');
    this.onChange = onChange;
    this.data = null;
    this.duration = 0;
    this.a = 0;
    this.b = 0;
    this.playhead = null;
    for (const handle of el.querySelectorAll('.handle')) this.bind(handle);
    el.addEventListener('click', e => {
      if (!this.data || e.target.closest('.handle')) return;
      const box = el.getBoundingClientRect();
      onSeek(((e.clientX - box.left) / box.width) * this.duration);
    });
    new ResizeObserver(() => this.draw()).observe(el);
  }

  setData(data, duration, a = 0, b = duration) {
    Object.assign(this, { data, duration, a, b, peaks: null, playhead: null });
    this.el.classList.remove('empty');
    this.layout();
  }

  /** 换一份波形数据（比如降噪之后的），选区不动。 */
  setSamples(data) {
    Object.assign(this, { data, peaks: null });
    this.draw();
  }

  clear() {
    this.data = null;
    this.el.classList.add('empty');
    this.canvas.width = this.canvas.width; // 清空画布
  }

  setRange(a, b) {
    Object.assign(this, { a, b });
    this.layout();
  }

  get minGap() {
    return Math.min(this.duration, Math.max(0.03, this.duration * 0.005));
  }

  move(edge, t) {
    if (edge === 'a') this.a = Math.max(0, Math.min(t, this.b - this.minGap));
    else this.b = Math.min(this.duration, Math.max(t, this.a + this.minGap));
    this.layout();
  }

  bind(handle) {
    const edge = handle.dataset.edge;
    handle.addEventListener('pointerdown', e => {
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', e => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      const box = this.el.getBoundingClientRect();
      this.move(edge, ((e.clientX - box.left) / box.width) * this.duration);
      this.onChange(false);
    });
    handle.addEventListener('lostpointercapture', () => this.onChange(true));
    handle.addEventListener('keydown', e => {
      const dir = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
      if (!dir) return;
      e.preventDefault();
      this.move(edge, this[edge] + dir * this.duration * (e.shiftKey ? 0.001 : 0.01));
      this.onChange(true);
    });
  }

  layout() {
    for (const handle of this.el.querySelectorAll('.handle')) {
      const t = this[handle.dataset.edge];
      handle.style.left = `${(t / this.duration) * 100}%`;
      handle.setAttribute('aria-valuenow', t.toFixed(2));
      handle.setAttribute('aria-valuemax', this.duration.toFixed(2));
    }
    this.draw();
  }

  draw() {
    const { data, duration } = this;
    const width = this.el.clientWidth;
    const height = this.el.clientHeight - this.rulerHeight;
    if (!data || !width) return;
    const g = setupCanvas(this.canvas, width, height + this.rulerHeight);
    const color = cssVars(this.el);
    const x = t => (t / duration) * width;

    const from = Math.max(this.a, this.clip?.a ?? 0);
    const to = Math.min(this.b, this.clip?.b ?? duration);
    g.fillStyle = color('--band');
    if (to > from) g.fillRect(x(from), 0, x(to) - x(from), height);
    if (this.rulerHeight) drawRuler(g, color, { width, y: height, span: duration });

    const count = Math.floor(width / BAR);
    if (this.peaks?.length !== count) {
      this.peaks = new Float32Array(count);
      const per = data.length / count;
      const stride = Math.max(1, Math.floor(per / 400));
      for (let i = 0; i < count; i++) {
        let peak = 0;
        // 上界要卡在数据长度以内：浮点误差会让最后一根柱子多读一个不存在的采样点，结果整条波形都画不出来
        const end = Math.min(data.length, Math.ceil((i + 1) * per));
        for (let j = Math.floor(i * per); j < end; j += stride) peak = Math.max(peak, Math.abs(data[j]));
        this.peaks[i] = peak;
      }
    }
    const scale = (height * 0.86) / (this.reference ?? Math.max(0.05, ...this.peaks));
    for (let i = 0; i < count; i++) {
      const t = ((i + 0.5) / count) * duration;
      const h = Math.max(2, this.peaks[i] * scale);
      g.fillStyle = t >= from && t <= to ? color('--accent') : color('--faint');
      g.fillRect(i * BAR, (height - h) / 2, BAR - 1, h);
    }
    if (this.playhead !== null) {
      g.fillStyle = color('--fg');
      g.fillRect(x(this.playhead) - 1, 0, 2, height);
    }
  }
}
