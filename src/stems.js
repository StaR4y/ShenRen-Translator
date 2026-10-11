// 音轨拆分在主线程这一侧：检查功能是否可用、管理 Worker。

const MODEL_URL = 'model/htdemucs.onnx';
export const STEMS = { vocals: '人声', drums: '鼓', bass: '贝斯', other: '其他' };
// 鼓没有音高，转出来只会是一堆乱音，所以默认不转
export const DEFAULT_MODES = { vocals: 'convert', drums: 'drop', bass: 'convert', other: 'convert' };

// 各轨提取音符时的调整。人声和贝斯一次只发一个音，可以放宽识别（boost 加在“音符”滑杆的值上）再按单旋律整理；
// 贝斯的低频尤其难认，不放宽的话大半会漏掉。
export const STEM_TUNING = {
  vocals: { boost: 0.25, mono: true },
  bass: { boost: 0.3, mono: true },
  drums: { boost: 0, mono: false },
  other: { boost: 0, mono: false },
};

let worker;
let busy = false;

const RUNTIME_URL = 'ort/ort-runtime.wasm';
const CACHE = 'yisheng-models'; // 和 Worker 里存模型用的是同一个缓存
const absolute = url => new URL(url, location.href).href;
const sizeOf = url =>
  fetch(url, { method: 'HEAD' }).then(
    res => (res.ok ? +res.headers.get('Content-Length') || 0 : null),
    () => null,
  );

/** 部署里放了拆分模型才提供这个功能（比如 Claude 的在线预览里就没有）。 */
export const stemsAvailable = () => sizeOf(MODEL_URL).then(size => size !== null);

/** 模型和运行时各有多大、模型是不是已经在浏览器缓存里（已经在的话就不用再下载）。 */
export async function modelInfo() {
  const [size, runtimeSize] = await Promise.all([sizeOf(MODEL_URL), sizeOf(RUNTIME_URL)]);
  const cached = await self.caches
    ?.open(CACHE)
    .then(cache => cache.match(absolute(MODEL_URL)))
    .then(Boolean, () => false);
  return { size, runtimeSize, cached: !!cached };
}

/** 中止正在进行的拆分。 */
export function cancelSeparation() {
  if (!busy) return;
  worker.terminate();
  worker = null;
  busy = false;
}

/** 把曲子拆成四轨单声道音频。onStatus(阶段, 文字, 进度 0~1 或 null)，阶段依次是 download、load、split */
export function separate(buffer, onStatus) {
  // 地址里带 ?cpu 可以强制不用显卡，用来测试没有 WebGPU 的情况
  worker ??= new Worker(`separate.js${location.search.includes('cpu') ? '?cpu' : ''}`, { type: 'module' });
  const left = buffer.getChannelData(0).slice();
  const right = buffer.getChannelData(buffer.numberOfChannels > 1 ? 1 : 0).slice();
  const mb = bytes => Math.round(bytes / 1e6);
  busy = true;
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === 'download') {
        onStatus('download', `下载模型 ${mb(data.loaded)} / ${mb(data.total)} MB`, data.loaded / data.total);
      } else if (data.type === 'stage') {
        onStatus('load', data.text, null);
      } else if (data.type === 'progress') {
        const total = Math.max(data.total, data.done); // 库报的总段数偶尔会少一段
        onStatus('split', total ? `拆分音轨 第 ${Math.min(data.done + 1, total)} / ${total} 段` : '拆分音轨', total ? data.done / total : 0);
      } else if (data.type === 'done') resolve(data);
      else reject(new Error(data.message));
    };
    worker.onerror = e => reject(new Error(e.message || '拆分模块没有加载成功'));
    worker.postMessage({ left, right, modelUrl: absolute(MODEL_URL) }, [left.buffer, right.buffer]);
  }).finally(() => (busy = false));
}
