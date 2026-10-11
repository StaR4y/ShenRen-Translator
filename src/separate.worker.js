// 音轨拆分（Demucs）。模型大、计算重，所以放在 Worker 里，并且只在用户点了“拆分音轨”后才加载。

import { DemucsProcessor } from 'demucs-web';
import * as ort from 'onnxruntime-web/webgpu';

// 运行时的两个文件各自指明地址。其中的加载脚本存成 .js 而不是原来的 .mjs：
// 不少服务器（比如默认配置的 nginx）不认识 .mjs，会按二进制发回来，浏览器就拒绝执行
ort.env.wasm.wasmPaths = {
  mjs: new URL('ort/ort-runtime.js', self.location.href).href,
  wasm: new URL('ort/ort-runtime.wasm', self.location.href).href,
};
// 多线程需要页面处于跨源隔离状态（服务器带 COOP/COEP 响应头），否则只能单线程
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

const post = (type, data) => self.postMessage({ type, ...data });
let processor;
let backend;

/** 下载模型并存进浏览器缓存，下次直接从缓存读。 */
async function fetchModel(url) {
  const cache = await self.caches?.open('yisheng-models').catch(() => null);
  const cached = await cache?.match(url);
  if (cached) return cached.arrayBuffer();

  const res = await fetch(url);
  if (!res.ok) throw new Error(`模型下载失败（${res.status}）`);
  const total = +res.headers.get('Content-Length') || 0;
  const data = new Uint8Array(total || (await res.clone().arrayBuffer()).byteLength);
  const reader = res.body.getReader();
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    data.set(value, loaded);
    loaded += value.length;
    post('download', { loaded, total: data.length });
  }
  await cache?.put(url, new Response(data, { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {});
  return data.buffer;
}

async function load(modelUrl) {
  const gpu = self.location.search.includes('cpu') ? null : await navigator.gpu?.requestAdapter().catch(() => null);
  backend = gpu ? 'WebGPU' : `CPU × ${ort.env.wasm.numThreads}`;
  processor = new DemucsProcessor({
    ort,
    sessionOptions: { executionProviders: gpu ? ['webgpu', 'wasm'] : ['wasm'] },
    onProgress: ({ currentSegment, totalSegments }) => post('progress', { done: currentSegment, total: totalSegments }),
  });
  const model = await fetchModel(modelUrl);
  post('stage', { text: '载入模型…' });
  await processor.loadModel(model);
}

self.onmessage = async ({ data: { left, right, modelUrl } }) => {
  try {
    if (!processor) await load(modelUrl);
    post('progress', { done: 0, total: 0 });
    const stems = await processor.separate(left, right);
    // 后面的识别和混音都按单声道处理，这里直接合并左右声道，省一半内存
    const mono = {};
    for (const [name, { left: l, right: r }] of Object.entries(stems)) {
      for (let i = 0; i < l.length; i++) l[i] = (l[i] + r[i]) / 2;
      mono[name] = l;
    }
    self.postMessage({ type: 'done', stems: mono, backend }, Object.values(mono).map(x => x.buffer));
  } catch (err) {
    post('error', { message: err?.message || String(err) });
  }
};
