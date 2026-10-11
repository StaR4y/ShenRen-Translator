// 音频处理：解码、转谱、音高检测、渲染。全部在浏览器本地完成。

import { BasicPitch } from '@spotify/basic-pitch';
import * as tf from '@tensorflow/tfjs';
import { prepare } from './notes.js';

export const SR = 44100;
const MODEL_SR = 22050;

let basicPitch;

export async function decode(arrayBuffer) {
  // OfflineAudioContext 解码不受自动播放限制，并且会统一重采样到 SR
  const ctx = new OfflineAudioContext(1, 1, SR);
  return ctx.decodeAudioData(arrayBuffer);
}

export function toMono(buffer) {
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[i] / buffer.numberOfChannels;
  }
  return out;
}

async function resampleMono(buffer, rate) {
  const ctx = new OfflineAudioContext(1, Math.ceil(buffer.duration * rate), rate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  return (await ctx.startRendering()).getChannelData(0);
}

/** 模型打包成单个 JSON（权重以 base64 内嵌），这样任何只认常见扩展名的静态托管都能放。 */
async function loadModel(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`识别模型加载失败（${res.status}）`);
  const { weightsBase64, ...artifacts } = await res.json();
  const weightData = Uint8Array.from(atob(weightsBase64), c => c.charCodeAt(0)).buffer;
  return tf.loadGraphModel(tf.io.fromMemory({ ...artifacts, weightData }));
}

/** 跑识别模型，返回可以反复按不同阈值提取音符的数据（见 notes.js）。 */
export async function analyse(buffer, modelUrl, onProgress) {
  basicPitch ??= new BasicPitch(loadModel(modelUrl));
  const audio = await resampleMono(buffer, MODEL_SR);
  const frames = [];
  const onsets = [];
  await basicPitch.evaluateModel(
    audio,
    (f, o) => {
      frames.push(...f);
      onsets.push(...o);
    },
    onProgress,
  );
  return prepare(frames, onsets);
}

/** 首尾静音以内的范围 [起, 止)（采样点下标），用作默认的截取位置。 */
export function soundBounds(x) {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  if (peak === 0) throw new Error('这段声音是静音的');
  const floor = peak * 0.01; // -40 dB
  let a = 0;
  let b = x.length;
  while (a < b && Math.abs(x[a]) < floor) a++;
  while (b > a && Math.abs(x[b - 1]) < floor) b--;
  return [a, b];
}

/** 截出一段并归一化，两端加极短的淡入淡出，避免切口处的爆音。 */
export function cutSample(x, a, b) {
  const out = x.slice(a, b);
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const fade = Math.min(Math.floor(SR * 0.003), out.length >> 2);
  for (let i = 0; i < out.length; i++) {
    const edge = Math.min(i, out.length - 1 - i);
    out[i] *= (edge < fade ? edge / fade : 1) / (peak || 1);
  }
  return out;
}

/** YIN 音高检测，返回各帧音高的中位数（MIDI，可带小数）；检测不到时返回 null。 */
export function detectRoot(x) {
  const maxTau = Math.floor(SR / 60);
  const minTau = Math.floor(SR / 2000);
  const win = Math.min(2048, x.length - maxTau - 1);
  if (win < 256) return null;
  const end = Math.min(x.length, SR * 3) - win - maxTau;
  const hop = Math.max(256, Math.floor(end / 60));
  const d = new Float32Array(maxTau + 1);
  const found = [];

  for (let i = 0; i < end; i += hop) {
    let sum = 0;
    d[0] = 1;
    for (let tau = 1; tau <= maxTau; tau++) {
      let acc = 0;
      for (let j = 0; j < win; j++) {
        const diff = x[i + j] - x[i + j + tau];
        acc += diff * diff;
      }
      sum += acc;
      d[tau] = sum > 0 ? (acc * tau) / sum : 1;
    }
    for (let tau = minTau; tau < maxTau; tau++) {
      if (d[tau] < 0.15 && d[tau] <= d[tau + 1]) {
        // 抛物线插值，得到亚采样精度的周期
        const denom = d[tau - 1] - 2 * d[tau] + d[tau + 1];
        const shift = denom ? (0.5 * (d[tau - 1] - d[tau + 1])) / denom : 0;
        found.push(69 + 12 * Math.log2(SR / (tau + shift) / 440));
        break;
      }
    }
  }
  if (found.length < 2) return null;
  found.sort((p, q) => p - q);
  return found[found.length >> 1];
}

const ENV_HOP = 1024;

export function rms(x, from = 0, to = x.length) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

/** 响度包络：每 1024 个采样点一个 RMS 值。 */
export function envelope(x) {
  const env = new Float32Array(Math.ceil(x.length / ENV_HOP));
  for (let i = 0; i < env.length; i++) env[i] = rms(x, i * ENV_HOP, Math.min(x.length, (i + 1) * ENV_HOP));
  return env;
}

/** 去掉起音处响度不到 gate 的音符。拆出来的某一轨在没有声音的地方只剩极轻的残留，识别模型却照样会报出音符。 */
export function gateNotes(notes, env, gate) {
  return notes.filter(n => {
    const from = Math.floor((n.start * SR) / ENV_HOP);
    const to = Math.min(env.length, Math.ceil(((n.start + Math.min(n.dur, 0.25)) * SR) / ENV_HOP));
    let peak = 0;
    for (let i = from; i < to; i++) peak = Math.max(peak, env[i]);
    return peak >= gate;
  });
}

/** 合并各轨的音符。同一个音常会漏到两轨里：音高相同、起音相差不到 60ms 的只留一个。 */
export function mergeNotes(lists) {
  const merged = [];
  const latest = new Map(); // 音高 -> 该音高最近的一个音符
  for (const note of lists.flat().sort((p, q) => p.start - q.start)) {
    const prev = latest.get(note.pitch);
    if (prev && note.start - prev.start < 0.06) {
      prev.amp = Math.max(prev.amp, note.amp);
      prev.dur = Math.max(prev.dur, note.start + note.dur - prev.start);
      continue;
    }
    const copy = { ...note };
    merged.push(copy);
    latest.set(note.pitch, copy);
  }
  return merged;
}

export function monoBuffer(data) {
  const buffer = new AudioBuffer({ length: data.length, sampleRate: SR });
  buffer.copyToChannel(data, 0);
  return buffer;
}

/** 截取 from~to 秒这一段，两端加极短的淡入淡出。 */
export function fadedSlice(x, from, to) {
  const out = x.slice(Math.round(from * SR), Math.min(x.length, Math.round(to * SR)));
  const fade = Math.min(Math.floor(SR * 0.005), out.length >> 1);
  for (let i = 0; i < fade; i++) {
    out[i] *= i / fade;
    out[out.length - 1 - i] *= i / fade;
  }
  return out;
}

/** 把若干段音频叠在一起。parts: [{ audio, at（从第几秒开始放）, gain }] */
export function sumParts(parts) {
  const out = new Float32Array(Math.max(0, ...parts.map(p => Math.round(p.at * SR) + p.audio.length)));
  for (const { audio, at, gain } of parts) {
    const offset = Math.round(at * SR);
    for (let i = 0; i < audio.length; i++) out[offset + i] += audio[i] * gain;
  }
  return out;
}

/** 原地把峰值缩放到 peak。 */
export function normalize(x, peak = 0.89) {
  let max = 0;
  for (const v of x) max = Math.max(max, Math.abs(v));
  if (max > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / max;
  return x;
}

/**
 * 把离采样原音高太远的音移若干个八度拉回 ±range 半音以内。
 * 采样变调太多会失真：往下三个八度就慢成一团闷响，往上则又短又尖。
 */
export function octaveFold(semitones, range) {
  while (semitones > range) semitones -= 12;
  while (semitones < -range) semitones += 12;
  return semitones;
}

/** 把采样按每个音符变调后叠加，返回单声道音频（没有归一化，各音符按识别出的强弱叠加）。 */
export async function render(notes, sample, root, { transpose = 0, release = 0.12, range = Infinity } = {}) {
  const sampleDur = sample.length / SR;
  const voices = notes.map(n => {
    const rate = 2 ** (octaveFold(n.pitch + transpose - root, range) / 12);
    const full = sampleDur / rate;
    const cut = n.dur + release < full;
    return { ...n, rate, cut, len: cut ? n.dur + release : full };
  });
  const total = Math.max(...voices.map(v => v.start + v.len)) + 0.05;
  const ctx = new OfflineAudioContext(1, Math.ceil(total * SR), SR);
  const buf = ctx.createBuffer(1, sample.length, SR);
  buf.copyToChannel(sample, 0);
  const peakAmp = Math.max(...notes.map(n => n.amp));

  for (const v of voices) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = v.rate;
    const gain = ctx.createGain();
    const level = 0.25 + (0.75 * v.amp) / peakAmp;
    gain.gain.value = level;
    src.connect(gain).connect(ctx.destination);
    src.start(v.start);
    if (v.cut) {
      // 音符比采样短：在音符结束处淡出；否则让采样自然放完
      gain.gain.setValueAtTime(level, v.start + v.dur);
      gain.gain.linearRampToValueAtTime(0, v.start + v.len);
      src.stop(v.start + v.len);
    }
  }

  return (await ctx.startRendering()).getChannelData(0);
}
