// 从识别模型的输出里提取音符。算法基于 basic-pitch 自带的 outputToNotesPoly，
// 改用一维数组，并把“每轮找全局最大值”换成一次排序，这样拖滑杆时能实时重算。
// 另外对第二遍（没有起音的持续音）加了两条限制，见 extract 里的说明。

const BINS = 88; // 每帧 88 个音高，对应钢琴的 A0~C8
const MIDI_OFFSET = 21;
const MIN_FRAMES = 5; // 最短音符，约 60ms
const TOLERANCE = 11; // 响度连续低于阈值这么多帧，才算这个音结束
const SUSTAIN_MARGIN = 0.1; // 没有起音的音，平均响度要比阈值高出这么多才算数
const ADJACENT = 3; // 与同音高的音相隔不超过这么多帧，就算是它的延续

// 帧号 -> 秒。模型按 2 秒一窗处理，窗与窗之间有一点固定偏移
const HOP = 256 / 22050;
const WINDOW_FRAMES = 172;
const WINDOW_OFFSET = HOP * (WINDOW_FRAMES - (22050 * 2 - 256) / 256) + 0.0018;
const frameTime = f => f * HOP - WINDOW_OFFSET * Math.floor(f / WINDOW_FRAMES);

/** 把模型输出整理成提取音符要用的形式：摊平的持续音矩阵，加上所有起音峰（与阈值无关，只算一次）。 */
export function prepare(frameRows, onsetRows) {
  const count = frameRows.length;
  const frames = new Float32Array(count * BINS);
  const onsets = new Float32Array(count * BINS);
  frameRows.forEach((row, t) => frames.set(row, t * BINS));
  onsetRows.forEach((row, t) => onsets.set(row, t * BINS));

  // 持续音突然变强的地方也当作起音，补上模型没报出来的起音
  const rise = new Float32Array(count * BINS);
  let onsetMax = 0;
  let riseMax = 0;
  for (let i = 0; i < onsets.length; i++) onsetMax = Math.max(onsetMax, onsets[i]);
  for (let i = 2 * BINS; i < frames.length; i++) {
    rise[i] = Math.max(0, Math.min(frames[i] - frames[i - BINS], frames[i] - frames[i - 2 * BINS]));
    riseMax = Math.max(riseMax, rise[i]);
  }
  for (let i = 0; i < onsets.length; i++) onsets[i] = Math.max(onsets[i], riseMax ? (onsetMax * rise[i]) / riseMax : 0);

  // 起音峰：沿时间方向的局部最大值
  const peaks = [];
  for (let t = 0; t < count; t++) {
    for (let f = 0; f < BINS; f++) {
      const i = t * BINS + f;
      const v = onsets[i];
      if (v > 0.05 && (t === 0 || v > onsets[i - BINS]) && (t === count - 1 || v > onsets[i + BINS])) peaks.push(i);
    }
  }
  return { count, frames, peaks: Uint32Array.from(peaks), peakValues: Float32Array.from(peaks, i => onsets[i]) };
}

/**
 * 提取音符，返回 [{ start, dur, pitch, amp }]，按开始时间排序。
 * sustained 为 true 时，连没有明显起音的持续音（长音、连音、人声、贝斯）也会提取出来。
 */
export function extract({ count, frames, peaks, peakValues }, onsetThresh, frameThresh, sustained = true) {
  const left = frames.slice(); // 还没被音符占用的响度
  const notes = [];
  const last = count - 1;

  const clear = (t, f) => {
    const i = t * BINS + f;
    left[i] = 0;
    if (f < BINS - 1) left[i + 1] = 0;
    if (f > 0) left[i - 1] = 0;
  };
  const mean = (from, to, f) => {
    let sum = 0;
    for (let t = from; t < to; t++) sum += frames[t * BINS + f];
    return sum / (to - from);
  };
  const byPitch = Array.from({ length: BINS }, () => []);
  const add = (from, to, f, amp = mean(from, to, f)) => {
    const note = { from, to, f, amp };
    notes.push(note);
    byPitch[f].push(note);
  };

  // 第一遍：从每个起音峰往后延伸，直到响度掉下去。从后往前处理，后面的音先占住自己的位置
  for (let p = peaks.length - 1; p >= 0; p--) {
    if (peakValues[p] < onsetThresh) continue;
    const from = Math.floor(peaks[p] / BINS);
    const f = peaks[p] % BINS;
    if (from >= last) continue;
    let t = from + 1;
    let quiet = 0;
    while (t < last && quiet < TOLERANCE) {
      quiet = left[t * BINS + f] < frameThresh ? quiet + 1 : 0;
      t++;
    }
    t -= quiet;
    if (t - from <= MIN_FRAMES) continue;
    for (let j = from; j < t; j++) clear(j, f);
    add(from, t, f);
  }

  // 第二遍：剩下的响度里从最强的地方开始，向前向后延伸成音符
  if (sustained) {
    const cells = [];
    for (let i = 0; i < left.length; i++) if (left[i] > frameThresh) cells.push(i);
    const strength = left.slice();
    for (const cell of Uint32Array.from(cells).sort((a, b) => strength[b] - strength[a])) {
      if (left[cell] <= frameThresh) continue; // 已经被前面的音符占用了
      const mid = Math.floor(cell / BINS);
      const f = cell % BINS;
      left[cell] = 0;

      let t = mid + 1;
      let quiet = 0;
      while (t < last && quiet < TOLERANCE) {
        quiet = left[t * BINS + f] < frameThresh ? quiet + 1 : 0;
        clear(t, f);
        t++;
      }
      const to = t - 1 - quiet;

      t = mid - 1;
      quiet = 0;
      while (t > 0 && quiet < TOLERANCE) {
        quiet = left[t * BINS + f] < frameThresh ? quiet + 1 : 0;
        clear(t, f);
        t--;
      }
      const from = t + 1 + quiet;

      if (to - from <= MIN_FRAMES) continue;
      // 紧接在同音高的音后面：是那个音的尾巴，延长它，而不是再触发一次
      const before = byPitch[f].find(n => Math.abs(n.to - from) <= ADJACENT);
      if (before) {
        before.to = Math.max(before.to, to);
        continue;
      }
      // 紧贴在同音高的音前面：多半是它起音前的一点预响，丢掉
      if (byPitch[f].some(n => Math.abs(n.from - to) <= ADJACENT)) continue;
      // 响度只是勉强过线的，多半是别的音的泛音
      const amp = mean(from, to, f);
      if (amp >= frameThresh + SUSTAIN_MARGIN) add(from, to, f, amp);
    }
  }

  return notes
    .map(n => ({ start: frameTime(n.from), dur: frameTime(n.to) - frameTime(n.from), pitch: n.f + MIDI_OFFSET, amp: n.amp }))
    .sort((p, q) => p.start - q.start);
}

/**
 * 按单旋律整理：同一时刻只留一个音。两个音重叠时，更强的那个胜出，弱的被截短或丢掉。
 * 用在人声、贝斯这类一次只发一个音的声部上，能去掉泛音被误认出来的多余音符。
 */
export function monophonic(notes) {
  const out = [];
  let cur = null;
  for (const source of notes) {
    const note = { ...source };
    const curEnd = cur ? cur.start + cur.dur : -Infinity;
    if (note.start >= curEnd) {
      out.push((cur = note));
    } else if (note.amp > cur.amp) {
      cur.dur = note.start - cur.start;
      if (cur.dur < 0.05) out.pop();
      out.push((cur = note));
    } else if (note.start + note.dur > curEnd + 0.06) {
      // 弱一些但拖得更久：接在当前音后面
      note.dur = note.start + note.dur - curEnd;
      note.start = curEnd;
      out.push((cur = note));
    }
  }
  return out;
}
