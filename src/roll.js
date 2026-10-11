// 音符编辑器（钢琴卷帘）：左边一列琴键，右边是音符，横轴时间、纵轴音高。
// 这里只管画和鼠标操作；音符数据和增删改都通过 host 交给外面处理。

import { cssVars, drawRuler, RULER, setupCanvas } from './wave.js';

const KEYS = 46; // 左侧琴键的宽度
const BLACK = [1, 3, 6, 8, 10];
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const EDGE = 7; // 离音符右端这么多像素以内，拖动是改长度而不是移动
const MAX_ZOOM = 64;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pitchClass = p => ((p % 12) + 12) % 12;
export const noteName = midi => NOTE_NAMES[pitchClass(midi)] + (Math.floor(midi / 12) - 1);

/**
 * host:
 *   ready()            有没有可以显示的内容
 *   notes()            要显示的音符 [{ start, dur, amp, stem, src }]，时间从选区起点算
 *   span()             整条时间轴有多长（秒）
 *   shown(note)        音符实际发声的音高
 *   color(stem)        某一轨音符用的颜色变量名
 *   newStem()          新加的音符归哪一轨
 *   center()           没有音符时纵向以哪个音高为中心
 *   seek(t) / add(from, to, pitch) / remove(notes) / change(note, dt, dPitch, dDur) / preview(pitch)
 *   status(text)       显示鼠标所指的位置
 *   viewChanged()      缩放或滚动之后调用
 */
export function createRoll(canvas, host) {
  const view = { zoom: 1, start: 0 };
  let tool = 'seek';
  let hover = null; // 鼠标所在的位置
  let drag = null; // 正在进行的拖动
  let playhead = null;

  const visible = () => host.span() / view.zoom;
  const fixView = () => {
    view.zoom = clamp(view.zoom, 1, MAX_ZOOM);
    view.start = clamp(view.start, 0, host.span() - visible());
  };

  /** 坐标换算。拖动期间沿用按下时的那一份，免得音高范围在手底下变。 */
  function layout() {
    if (drag?.layout) return drag.layout;
    fixView();
    const width = canvas.clientWidth;
    const height = canvas.clientHeight - RULER;
    const pitches = host.notes().map(host.shown);
    if (!pitches.length) pitches.push(host.center() - 8, host.center() + 8);
    // 上下各多留三行，方便往现有范围外面加音
    let lo = Math.min(...pitches) - 3;
    let hi = Math.max(...pitches) + 3;
    while (hi - lo < 18) (lo--, hi++);
    const rowH = height / (hi - lo + 1);
    const { start } = view;
    const perSecond = (width - KEYS) / visible();
    return {
      width, height, lo, hi, rowH,
      x: t => KEYS + (t - start) * perSecond,
      w: dur => dur * perSecond,
      y: pitch => (hi - pitch) * rowH,
      timeAt: px => start + (px - KEYS) / perSecond,
      pitchAt: py => clamp(hi - Math.floor(py / rowH), lo, hi),
    };
  }

  /** 鼠标事件对应的位置。 */
  function locate(e) {
    const rect = canvas.getBoundingClientRect();
    const l = layout();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    return {
      px,
      t: clamp(l.timeAt(px), 0, host.span()),
      pitch: l.pitchAt(py),
      area: py >= l.height ? 'ruler' : px < KEYS ? 'keys' : 'notes',
    };
  }

  /** 这个位置上的音符（有重叠时取后画的那个，也就是看得见的那个）。 */
  function noteAt({ t, pitch }) {
    const slack = 3 / layout().w(1); // 两边各放宽 3 像素，短音符也点得中
    return host.notes().findLast(n => host.shown(n) === pitch && t >= n.start - slack && t <= n.start + n.dur + slack);
  }

  function draw(at = playhead) {
    playhead = at;
    if (!canvas.clientWidth) return;
    // 播放时让画面跟着播放头走
    if (at !== null && !drag && (at < view.start || at > view.start + visible())) {
      view.start = at;
      fixView();
      host.viewChanged();
    }
    const l = layout();
    const { width, height, lo, hi, rowH, x, y } = l;
    const g = setupCanvas(canvas, width, height + RULER);
    if (!host.ready()) return;
    const color = cssVars(canvas);
    const editing = tool !== 'seek';

    // 底：黑键所在的行颜色深一点
    for (let p = lo; p <= hi; p++) {
      if (BLACK.includes(pitchClass(p))) {
        g.fillStyle = color('--band');
        g.fillRect(KEYS, y(p), width - KEYS, rowH);
      }
      if (pitchClass(p) === 0) {
        g.fillStyle = color('--grid');
        g.fillRect(KEYS, Math.round(y(p) + rowH), width - KEYS, 1);
      }
    }
    if (hover?.area === 'notes' && editing) {
      g.fillStyle = color('--grid');
      g.fillRect(KEYS, y(hover.pitch), width - KEYS, rowH);
    }
    drawRuler(g, color, { x0: KEYS, width: width - KEYS, y: height, span: visible(), from: view.start });

    // 音符
    g.save();
    g.beginPath();
    g.rect(KEYS, 0, width - KEYS, height);
    g.clip();
    const box = (start, dur, pitch) => [x(start), y(pitch) + 0.5, Math.max(2, l.w(dur) - 1), Math.max(2, rowH - 1)];
    const moving = drag?.note;
    for (const n of host.notes()) {
      if (n === moving) continue;
      g.fillStyle = color(host.color(n.stem));
      g.globalAlpha = drag?.erased?.has(n) ? 0.15 : 0.5 + 0.5 * Math.min(1, n.amp);
      g.fillRect(...box(n.start, n.dur, host.shown(n)));
    }
    g.globalAlpha = 1;
    // 鼠标指着的音符描边：删除工具是红的，移动工具是深色的
    const target = !drag && hover?.area === 'notes' && (tool === 'erase' || tool === 'move') ? noteAt(hover) : null;
    if (target) {
      g.strokeStyle = color(tool === 'erase' ? '--error' : '--fg');
      g.lineWidth = 2;
      g.strokeRect(...box(target.start, target.dur, host.shown(target)));
    }
    if (drag?.type === 'draw') {
      g.fillStyle = color(host.color(host.newStem()));
      g.globalAlpha = 0.65;
      g.fillRect(...box(Math.min(drag.from, drag.to), Math.abs(drag.to - drag.from), drag.pitch));
    }
    if (moving) {
      g.fillStyle = color(host.color(moving.stem));
      g.globalAlpha = 0.85;
      const rect = box(Math.max(0, moving.start + drag.dt), Math.max(0.05, moving.dur + drag.dDur), host.shown(moving) + drag.dPitch);
      g.fillRect(...rect);
      g.globalAlpha = 1;
      g.strokeStyle = color('--fg');
      g.lineWidth = 1.5;
      g.strokeRect(...rect);
    }
    g.globalAlpha = 1;
    if (at !== null) {
      g.fillStyle = color('--fg');
      g.fillRect(x(at) - 1, 0, 2, height);
    }
    g.restore();

    // 左侧琴键
    g.fillStyle = color('--key-white');
    g.fillRect(0, 0, KEYS, height);
    g.font = `10px ${color('--mono')}`;
    g.textBaseline = 'middle';
    for (let p = lo; p <= hi; p++) {
      const black = BLACK.includes(pitchClass(p));
      const lit = hover && hover.area !== 'ruler' && hover.pitch === p;
      if (black) {
        g.fillStyle = color(lit ? '--muted' : '--key-black');
        g.fillRect(0, y(p), KEYS * 0.62, rowH);
      } else if (lit) {
        g.fillStyle = color('--key-lit');
        g.fillRect(0, y(p), KEYS, rowH);
      }
      // 白键之间的分隔线画在 B/C 和 E/F 之间，其余白键被黑键隔开
      if ([0, 5].includes(pitchClass(p))) {
        g.fillStyle = color('--key-edge');
        g.fillRect(0, Math.round(y(p) + rowH), KEYS, 1);
      }
      if (pitchClass(p) === 0 && rowH >= 5) {
        g.fillStyle = color('--key-black');
        g.fillText(noteName(p), KEYS - 24, y(p) + rowH / 2);
      }
    }
    g.fillStyle = color('--key-edge');
    g.fillRect(KEYS - 1, 0, 1, height);
  }

  canvas.addEventListener('pointerdown', e => {
    if (!host.ready() || e.button !== 0) return;
    const point = locate(e);
    if (point.area === 'keys') return host.preview(point.pitch);
    if (point.area === 'ruler' || tool === 'seek') return host.seek(point.t);
    e.preventDefault();
    const hit = noteAt(point);
    if (tool === 'draw') {
      if (host.newStem() === null) return host.status('先把某一轨设为“转换”，才能往里加音符');
      drag = { type: 'draw', from: point.t, to: point.t, pitch: point.pitch, layout: layout() };
      host.preview(point.pitch);
    } else if (tool === 'erase') {
      drag = { type: 'erase', erased: new Set(hit ? [hit] : []) };
    } else if (hit) {
      const l = layout();
      const resize = point.px > l.x(hit.start + hit.dur) - EDGE && l.w(hit.dur) > EDGE * 2;
      drag = { type: resize ? 'resize' : 'move', note: hit, t0: point.t, p0: point.pitch, dt: 0, dPitch: 0, dDur: 0, layout: l };
    } else {
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    draw();
  });

  canvas.addEventListener('pointermove', e => {
    if (!host.ready()) return;
    const point = locate(e);
    hover = point;
    if (drag?.type === 'draw') {
      drag.to = point.t;
    } else if (drag?.type === 'erase') {
      const hit = noteAt(point);
      if (hit) drag.erased.add(hit);
    } else if (drag?.type === 'move') {
      const previous = drag.dPitch;
      drag.dt = point.t - drag.t0;
      drag.dPitch = point.pitch - drag.p0;
      if (drag.dPitch !== previous) host.preview(host.shown(drag.note) + drag.dPitch);
    } else if (drag?.type === 'resize') {
      drag.dDur = point.t - drag.t0;
    }
    // 移动工具在音符右端显示成“拉长”的光标
    const over = tool === 'move' && !drag && point.area === 'notes' ? noteAt(point) : null;
    const l = layout();
    canvas.classList.toggle('resizing', drag?.type === 'resize' || (!!over && point.px > l.x(over.start + over.dur) - EDGE && l.w(over.dur) > EDGE * 2));
    host.status(point.area === 'ruler' ? '' : `${noteName(point.pitch)}${point.area === 'notes' ? ` · ${point.t.toFixed(2)} 秒` : ''}`);
    draw();
  });

  canvas.addEventListener('pointerup', () => {
    const done = drag;
    drag = null;
    if (!done) return;
    if (done.type === 'draw') host.add(done.from, done.to, done.pitch);
    else if (done.type === 'erase' && done.erased.size) host.remove([...done.erased]);
    else if ((done.type === 'move' || done.type === 'resize') && (done.dt || done.dPitch || done.dDur)) {
      host.change(done.note, done.dt, done.dPitch, done.dDur);
    }
    draw();
  });

  canvas.addEventListener('pointercancel', () => {
    drag = null;
    draw();
  });

  canvas.addEventListener('pointerleave', () => {
    if (drag) return;
    hover = null;
    host.status('');
    draw();
  });

  // 按住 Ctrl / ⌘ 滚动是缩放；放大之后横向滚动（或按住 Shift 滚动）是平移
  canvas.addEventListener(
    'wheel',
    e => {
      if (!host.ready()) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomBy(Math.exp(-e.deltaY * 0.01), locate(e).t);
      } else if (view.zoom > 1 && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) {
        e.preventDefault();
        view.start += ((e.deltaX || e.deltaY) / (canvas.clientWidth - KEYS)) * visible();
        fixView();
        host.viewChanged();
        draw();
      }
    },
    { passive: false },
  );

  /** 以 anchor 这一刻为中心缩放（默认是画面中间）。 */
  function zoomBy(factor, anchor = view.start + visible() / 2) {
    const share = (anchor - view.start) / visible();
    view.zoom = clamp(view.zoom * factor, 1, MAX_ZOOM);
    view.start = anchor - share * visible();
    fixView();
    host.viewChanged();
    draw();
  }

  new ResizeObserver(() => draw()).observe(canvas);

  return {
    view,
    draw,
    zoomBy,
    get tool() {
      return tool;
    },
    setTool(next) {
      tool = next;
      canvas.dataset.tool = next;
      draw();
    },
    /** 回到显示整条时间轴。 */
    fit() {
      view.zoom = 1;
      view.start = 0;
      host.viewChanged();
      draw();
    },
    /** 把画面滚到 share（0~1）的位置。 */
    scrollTo(share) {
      view.start = share * (host.span() - visible());
      fixView();
      draw();
    },
    /** 当前滚动到了哪里（0~1）。 */
    get scrolled() {
      const room = host.span() - visible();
      return room > 0 ? view.start / room : 0;
    },
  };
}
