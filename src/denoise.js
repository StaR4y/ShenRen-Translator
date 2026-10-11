// 谱减法降噪，不需要模型。
// 把声音切成一小段一小段，从最安静的那些段里估出底噪在各个频率上有多大，
// 然后把每一段里和底噪差不多大的频率成分压下去，明显比底噪响的成分原样保留。
// 只对持续不变的底噪（嘶嘶声、电流声、风扇声）有效。

const SIZE = 1024; // 每段的长度（采样点），约 23ms
const HOP = SIZE / 4;
const BINS = SIZE / 2 + 1;
const QUIET_SHARE = 0.2; // 最安静的这部分段落被当作“只有底噪”
const OVER = 2; // 按估出的底噪的这么多倍来减，留一点余量
const FLOOR = 0.05; // 被判为底噪的成分最多压到原来的 5%（-26 dB），压到 0 反而会有明显的水声

const WINDOW = Float32Array.from({ length: SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / SIZE));
const COS = Float32Array.from({ length: SIZE / 2 }, (_, i) => Math.cos((2 * Math.PI * i) / SIZE));
const SIN = Float32Array.from({ length: SIZE / 2 }, (_, i) => Math.sin((2 * Math.PI * i) / SIZE));

/** 原地做快速傅里叶变换；inverse 为 true 时做逆变换。 */
function fft(re, im, inverse = false) {
  for (let i = 1, j = 0; i < SIZE; i++) {
    let bit = SIZE >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= SIZE; len <<= 1) {
    const step = SIZE / len;
    for (let start = 0; start < SIZE; start += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = COS[k * step];
        const wi = inverse ? SIN[k * step] : -SIN[k * step];
        const a = start + k;
        const b = a + len / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  if (inverse) for (let i = 0; i < SIZE; i++) (re[i] /= SIZE), (im[i] /= SIZE);
}

/** 完全落在声音内部的各段里，最安静的那一部分的下标。 */
function quietFrames(x) {
  const frames = [];
  for (let start = 0; start + SIZE <= x.length; start += HOP) {
    let energy = 0;
    for (let i = 0; i < SIZE; i++) energy += x[start + i] ** 2;
    frames.push({ start, energy });
  }
  frames.sort((p, q) => p.energy - q.energy);
  return frames.slice(0, Math.max(1, Math.round(frames.length * QUIET_SHARE)));
}

/** 底噪比最响处低多少分贝（负数，越小越干净）；声音太短估不出来时返回 null。 */
export function noiseFloorDb(x) {
  const quiet = quietFrames(x);
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  if (!quiet.length || !peak) return null;
  const level = Math.sqrt(quiet.reduce((sum, f) => sum + f.energy, 0) / (quiet.length * SIZE));
  return Math.max(-99, Math.round(20 * Math.log10(level / peak + 1e-9)));
}

/** 降噪。strength 从 0（不处理）到 1（最强）。 */
export function denoise(x, strength) {
  const quiet = quietFrames(x);
  if (!strength || !quiet.length) return x;
  const re = new Float32Array(SIZE);
  const im = new Float32Array(SIZE);
  const analyse = start => {
    for (let i = 0; i < SIZE; i++) {
      const j = start + i;
      re[i] = j >= 0 && j < x.length ? x[j] * WINDOW[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
  };

  // 底噪在各个频率上的平均大小
  const noise = new Float32Array(BINS);
  for (const { start } of quiet) {
    analyse(start);
    for (let k = 0; k < BINS; k++) noise[k] += Math.hypot(re[k], im[k]) / quiet.length;
  }

  const out = new Float32Array(x.length);
  const gain = new Float32Array(BINS);
  const smooth = new Float32Array(BINS);
  const held = new Float32Array(BINS); // 上一段的增益，让声音的尾巴慢慢收，而不是被一刀切掉
  for (let start = -SIZE + HOP; start < x.length; start += HOP) {
    analyse(start);
    for (let k = 0; k < BINS; k++) {
      const power = re[k] * re[k] + im[k] * im[k];
      gain[k] = Math.sqrt(Math.max(1 - (OVER * noise[k]) ** 2 / (power + 1e-12), FLOOR * FLOOR));
    }
    for (let k = 0; k < BINS; k++) {
      // 在相邻频率之间抹平，减少零星冒出来的“水声”
      const near = (gain[Math.max(0, k - 1)] + gain[k] + gain[Math.min(BINS - 1, k + 1)]) / 3;
      held[k] = Math.max(near, held[k] * 0.7);
      smooth[k] = 1 - strength * (1 - held[k]);
    }
    for (let k = 0; k < BINS; k++) {
      re[k] *= smooth[k];
      im[k] *= smooth[k];
      if (k > 0 && k < SIZE / 2) {
        re[SIZE - k] *= smooth[k];
        im[SIZE - k] *= smooth[k];
      }
    }
    fft(re, im, true);
    // 四段重叠相加；汉宁窗用两次（分析和合成），重叠后的总和是 1.5
    for (let i = 0; i < SIZE; i++) {
      const j = start + i;
      if (j >= 0 && j < x.length) out[j] += (re[i] * WINDOW[i]) / 1.5;
    }
  }
  return out;
}
