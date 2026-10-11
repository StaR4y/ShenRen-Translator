// 本地预览用的静态服务器：node serve.mjs [端口]
// 带上 COOP/COEP 两个响应头，音轨拆分在没有 WebGPU 的浏览器里才能用多线程。
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./dist', import.meta.url));
const port = +process.argv[2] || 5173;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
};

createServer((req, res) => {
  let file = join(root, normalize(decodeURIComponent(new URL(req.url, 'http://localhost').pathname)));
  let stat;
  try {
    if (!file.startsWith(root)) throw new Error('outside root');
    stat = statSync(file);
    if (stat.isDirectory()) stat = statSync((file = join(file, 'index.html')));
  } catch {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': types[extname(file)] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
}).listen(port, () => console.log(`http://localhost:${port}`));
