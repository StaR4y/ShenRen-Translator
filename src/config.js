// 部署前要改的东西都在这里。

/** 本项目的开源仓库地址；留空则页面上不显示这个链接。 */
export const PROJECT_URL = 'https://github.com/StaR4y/ShenRen-Translator';

/** 内置的声音，第一个是打开页面时默认载入的。文件放在 static/ 里。 */
export const PRESETS = [
  { url: 'bing.mp3', name: '冰' },
  { url: 'dog.mp3', name: '大狗叫' },
];

/** 用到的第三方项目，显示在页脚和下载确认里。 */
export const CREDITS = {
  basicPitch: { name: 'Basic Pitch', by: 'Spotify', license: 'Apache-2.0', url: 'https://github.com/spotify/basic-pitch-ts', use: '识别音符' },
  tfjs: { name: 'TensorFlow.js', by: 'Google', license: 'Apache-2.0', url: 'https://github.com/tensorflow/tfjs', use: '运行识别模型' },
  demucsWeb: { name: 'demucs-web', by: 'timcsy', license: 'MIT', url: 'https://github.com/timcsy/demucs-web', use: '拆分音轨（浏览器版）' },
  demucs: { name: 'Demucs', by: 'Meta', license: 'MIT', url: 'https://github.com/facebookresearch/demucs', use: '拆分模型的原始项目' },
  ort: { name: 'ONNX Runtime Web', by: 'Microsoft', license: 'MIT', url: 'https://github.com/microsoft/onnxruntime', use: '运行拆分模型' },
};

/** 拆分模型文件的出处（demucs-web 作者发布的 ONNX 版本）。 */
export const MODEL_SOURCE = 'https://huggingface.co/timcsy/demucs-web-onnx';
