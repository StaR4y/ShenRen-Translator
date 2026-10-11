// 打包成纯静态站点：dist/ 里的文件原样丢到任何静态服务器即可。
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');

await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  outfile: 'dist/app.js',
  define: { global: 'globalThis' },
  logLevel: 'info',
});

// 音轨拆分单独打包成一个模块 Worker，用到时才加载
await build({
  entryPoints: ['src/separate.worker.js'],
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'es2022',
  outfile: 'dist/separate.js',
  logLevel: 'info',
});
mkdirSync('dist/ort');
// 换成服务器普遍认识的扩展名，见 separate.worker.js 里的说明
for (const ext of ['mjs', 'wasm']) {
  cpSync(`node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.${ext}`, `dist/ort/ort-runtime.${ext === 'mjs' ? 'js' : ext}`);
}

// 把模型结构和权重合成一个 JSON 文件
const modelDir = 'node_modules/@spotify/basic-pitch/model';
const { weightsManifest, ...model } = JSON.parse(readFileSync(`${modelDir}/model.json`, 'utf8'));
mkdirSync('dist/model');
writeFileSync(
  'dist/model/basic-pitch.json',
  JSON.stringify({
    ...model,
    weightSpecs: weightsManifest.flatMap(group => group.weights),
    weightsBase64: Buffer.concat(
      weightsManifest.flatMap(group => group.paths.map(path => readFileSync(`${modelDir}/${path}`))),
    ).toString('base64'),
  }),
);
cpSync('static', 'dist', { recursive: true });

const [head, body] = readFileSync('page.html', 'utf8').split('<!--body-->');
writeFileSync(
  'dist/index.html',
  `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>body{margin:0}[hidden]{display:none!important}</style>
${head.trim()}
</head>
<body>
${body.trim()}
</body>
</html>
`,
);
