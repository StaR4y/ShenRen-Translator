# 🧊 神人翻译器

让你的音乐，听起来更神人：把一首曲子里的每个音，都换成你选的那一声（默认是“冰”）。

纯静态网页：识别音符、拆分音轨、降噪、合成全部在访问者的浏览器里完成，服务器只负责发文件。

## 运行

```bash
npm install
npm run fetch-model   # 可选：下载拆分音轨用的模型（约 180 MB）
npm run build
npm run serve         # http://localhost:5173
```

不下载模型也能用，只是页面上不会出现“拆分音轨”。

## 部署

`npm run build` 之后，把 `dist/` 里的文件原样放到任何静态服务器即可。全部是相对路径，放在子目录下也行；不依赖任何外部 CDN。

- **建议开 HTTPS**。没有 HTTPS 时页面照常能用，但拆分模型没法存进浏览器缓存（每次都要重新下 180 MB），也用不了多线程。
- **不想提供拆分音轨**：删掉 `dist/model/htdemucs.onnx`（连同 `dist/ort/` 和 `dist/separate.js`），按钮会自动隐藏，站点只剩约 3 MB。
- **可选的两个响应头**：加上之后，没有 WebGPU 的浏览器拆分音轨时才能用多线程；不加也能用，只是慢。`serve.mjs` 是带这两个头的本地示例。

### 用 1Panel 部署

1. 「网站」→「创建网站」→「静态网站」，填好域名。
2. 进入这个网站的目录（网站列表里点目录图标，默认是 `/opt/1panel/apps/openresty/openresty/www/sites/<域名>/index`），把打包好的 zip 传上去并解压，保证 `index.html` 直接在 `index/` 下面。
3. 在网站设置里申请证书、开启 HTTPS。
4. （可选）「配置文件」里，在 `server { ... }` 内加上：

   ```nginx
   add_header Cross-Origin-Opener-Policy same-origin always;
   add_header Cross-Origin-Embedder-Policy require-corp always;
   ```

## 目录

| 位置 | 内容 |
|---|---|
| `page.html` | 页面的结构和样式 |
| `src/main.js` | 界面逻辑 |
| `src/audio.js` `src/notes.js` | 解码、识别音符、合成 |
| `src/roll.js` | 音符编辑器 |
| `src/stems.js` `src/separate.worker.js` | 拆分音轨 |
| `src/denoise.js` | 谱减法降噪 |
| `src/gate.js` | 进站提示和彩纸 |
| `src/config.js` | 开源仓库地址、内置声音、第三方项目列表 |
| `static/` | 内置声音、图片、模型，打包时原样复制到 `dist/` |
| `python/` | 最早的命令行原型，和网页无关 |

## 常改的地方

- **开源仓库地址**：`src/config.js` 里的 `PROJECT_URL`，填上之后页面右上角和页脚会出现链接。
- **内置声音**：把文件放进 `static/`，在 `src/config.js` 的 `PRESETS` 里加一行。
- **配色**：`page.html` 开头的 `:root` 里。

## 用到的第三方项目

- [Basic Pitch](https://github.com/spotify/basic-pitch-ts)（Spotify，Apache-2.0）：识别音符
- [TensorFlow.js](https://github.com/tensorflow/tfjs)（Google，Apache-2.0）：运行识别模型
- [demucs-web](https://github.com/timcsy/demucs-web)（timcsy，MIT）：浏览器里拆分音轨
- [Demucs](https://github.com/facebookresearch/demucs)（Meta，MIT）：拆分模型的原始项目
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime)（Microsoft，MIT）：运行拆分模型

`static/` 里的内置声音和图片来自网络素材，公开发布前请自行确认是否有权使用。
