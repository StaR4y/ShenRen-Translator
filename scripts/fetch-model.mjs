// 下载音轨拆分用的模型（约 180 MB）。它太大，不放进 git 仓库；克隆之后运行一次 npm run fetch-model。
// 不下载也能用，只是页面上不会出现“拆分音轨”。
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const URL = 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx';
const FILE = 'static/model/htdemucs.onnx';

if (existsSync(FILE)) {
  console.log(`${FILE} 已经在了`);
} else {
  mkdirSync('static/model', { recursive: true });
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`下载失败：${res.status}`);
  console.log(`正在下载 ${Math.round(res.headers.get('content-length') / 1e6)} MB …`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(FILE));
  console.log(`已保存到 ${FILE}`);
}
