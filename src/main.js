import {
  analyse, cutSample, decode, detectRoot, envelope, fadedSlice, gateNotes, mergeNotes, monoBuffer, normalize, octaveFold,
  render, rms, soundBounds, SR, sumParts, toMono,
} from './audio.js';
import './gate.js';
import { CREDITS, MODEL_SOURCE, PRESETS, PROJECT_URL } from './config.js';
import { denoise, noiseFloorDb } from './denoise.js';
import { encodeWav, zipSingle } from './encode.js';
import { extract, monophonic } from './notes.js';
import { createRoll, noteName } from './roll.js';
import { cancelSeparation, DEFAULT_MODES, modelInfo, separate, STEM_TUNING, STEMS, stemsAvailable } from './stems.js';
import { $, confirmDialog, createTask } from './ui.js';
import { Wave } from './wave.js';

const MODEL_URL = 'model/basic-pitch.json';
const STEM_KEYS = Object.keys(STEMS);
const clock = (s, digits = 2) => `${Math.floor(s / 60)}:${(s % 60).toFixed(digits).padStart(digits + 3, '0')}`;
// 视频文件直接取其中的音轨，不需要先另存成 mp3
const isVideo = (blob, name) => blob.type.startsWith('video/') || /\.(mp4|m4v|mov|mkv|webm)$/i.test(name);
const channels = buffer => (buffer.numberOfChannels > 1 ? '立体声' : '单声道');
const size = bytes => (bytes < 1e6 ? `${Math.round(bytes / 1e3)} KB` : `${(bytes / 1e6).toFixed(1)} MB`);

// 参数面板上的每个滑杆。没拆分时用 all 这一套；拆分后每轨各有一套，选“全部”时一起改
const PARAM_IDS = ['pitch', 'density', 'release', 'range', 'volume'];
const paramDefaults = () => Object.fromEntries(PARAM_IDS.map(id => [id, +$(id).defaultValue]));
const emptyEdits = () => ({ removed: new Set(), added: [], history: [], future: [] });

const state = {
  // { name, buffer, level, activations, stems, modes, ready, allNotes, edits }
  // level 是整首的平均响度；ready 表示音符已识别完；modes 是每轨的处理方式；
  // stems 拆分后才有：{ 轨名: { audio, env, quiet, activations, buffer } }；
  // allNotes 是自动识别出的全部音符（时间按整首算）；
  // edits 是手工改动：removed 是被删音符的标识，added 是手工加的音符，history / future 是撤销和重做栈
  song: null,
  // { name, original, raw, buffer, mono, bounds }：original / raw 是没降噪的音频和它的单声道，buffer / mono 是当前在用的
  sample: null,
  cut: null, // 截好的采样
  cutId: 0, // 每次重新截取加一，用来判断缓存是否还有效
  root: 60,
  notes: [], // 选区内最终要发声的音符，时间从选区起点算；src 指回原来的音符
  out: null, // { wav, buffer }
  params: Object.fromEntries(['all', ...STEM_KEYS].map(key => [key, paramDefaults()])),
  track: 'all', // 参数面板当前在调哪一轨
  addStem: null, // 新加的音符归哪一轨
};
let songJob = 0;
let sampleJob = 0;
let renderJob = 0;
let renderTimer;

const paramsFor = note => state.params[note.stem ?? 'all'];
const songTask = createTask($('song-task'));
const sampleTask = createTask($('sample-task'));
const outTask = createTask($('out-task'));

// ---------- 开场的三步 ----------

function showSteps() {
  const step = (id, text, done) => {
    $(id).querySelector('em').textContent = text;
    $(id).classList.toggle('done', done);
  };
  const { song, sample, out } = state;
  step('step-song', song ? song.name : '音频或视频都行', !!song?.ready);
  step('step-sample', sample ? sample.name : '还没有选', !!state.cut);
  step('step-out', out ? '可以试听和下载了' : song?.ready && state.cut ? '生成中…' : '等前两步完成', !!out);
}

// ---------- 保存文件 ----------

// 在 Claude 的页面里直接下载会被拦截，要走它的保存接口；自己部署时没有这个对象
const downloads = Promise.resolve(window.claude?.use?.('downloads')).catch(() => null);
downloads.then(api => {
  if (api) $('save-text').textContent = '保存 WAV（zip）';
});

/** 保存一个 WAV，返回是否成功交给了浏览器。 */
async function saveWav(base, wav) {
  const api = await downloads;
  if (!api) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
    a.download = `${base}.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return true;
  }
  try {
    await api.save({ filename: `${base}.zip`, data: zipSingle(`${base}.wav`, wav) });
    return true;
  } catch (err) {
    if (err?.code !== 'declined') $('save-note').textContent = '这里保存不了';
    return false;
  }
}

const songBase = () => state.song.name.replace(/\.[^.]+$/, '');

// ---------- 播放 ----------

const player = {
  ctx: null,
  node: null,
  owner: null,
  from: 0,
  startedAt: 0,
  frame: 0,

  context() {
    this.ctx ??= new AudioContext();
    this.ctx.resume();
    return this.ctx;
  },

  /** owner: { button, show(seconds | null) } */
  play(owner, buffer, from, to) {
    this.stop();
    if (to <= from) return;
    const ctx = this.context();
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    node.onended = () => this.node === node && this.stop();
    node.start(0, from, Math.max(0.01, to - from));
    Object.assign(this, { node, owner, from, startedAt: ctx.currentTime });
    owner.button.classList.add('playing');
    owner.button.setAttribute('aria-label', '停止');
    const tick = () => {
      owner.show(this.from + ctx.currentTime - this.startedAt);
      this.frame = requestAnimationFrame(tick);
    };
    tick();
  },

  stop(onlyOwner) {
    const { node, owner } = this;
    if (!node || (onlyOwner && onlyOwner !== owner)) return;
    cancelAnimationFrame(this.frame);
    node.onended = null;
    node.stop();
    this.node = this.owner = null;
    owner.button.classList.remove('playing');
    owner.button.setAttribute('aria-label', '播放');
    owner.show(null);
  },

  toggle(owner, start) {
    if (this.owner === owner) this.stop();
    else start();
  },
};

/** 一条可剪切的波形：播放键播放选区，点波形从该处播到选区结束。 */
function track(prefix, source, onChange) {
  const button = $(`${prefix}-play`);
  const owner = {
    button,
    show(t) {
      wave.playhead = t;
      wave.draw();
    },
  };
  const play = (from = wave.a) => player.play(owner, source().buffer, from, wave.b);
  const wave = new Wave($(`${prefix}-wave`), {
    onChange(final) {
      player.stop(owner);
      showRange();
      onChange(final);
    },
    onSeek: t => t >= wave.a && t < wave.b && play(t),
  });
  const showRange = () => {
    $(`${prefix}-a`).textContent = clock(wave.a);
    $(`${prefix}-b`).textContent = clock(wave.b);
    $(`${prefix}-len`).textContent = clock(wave.b - wave.a);
  };
  button.addEventListener('click', () => player.toggle(owner, play));
  const enable = on => (button.disabled = $(`${prefix}-reset`).disabled = !on);
  const clear = () => {
    wave.clear();
    enable(false);
    for (const key of ['a', 'b', 'len']) $(`${prefix}-${key}`).textContent = '–';
  };
  return { wave, owner, showRange, enable, clear };
}

// ---------- 曲子 ----------

const song = track('song', () => state.song, () => {
  for (const key of STEM_KEYS) {
    player.stop(stemOwners[key]);
    stemWaves[key].clip = { a: song.wave.a, b: song.wave.b };
    stemWaves[key].draw();
  }
  filterNotes();
});

async function loadSong(blob, name) {
  const job = ++songJob;
  player.stop();
  cancelSeparation();
  state.song = null;
  state.notes = [];
  renderCache.clear();
  $('split').disabled = true;
  for (const wave of Object.values(stemWaves)) wave.clear();
  selectTrack('all');
  showStemControls();
  showEdits();
  roll.fit();
  $('song-name').textContent = name;
  $('song-meta').textContent = '';
  song.clear();
  const video = isVideo(blob, name);
  songTask.start(['读取文件', '识别音符']);
  songTask.stage(0);
  songTask.set(video ? '从视频里取出音轨…' : '解码中…', null);
  invalidate();
  try {
    const buffer = await decode(await blob.arrayBuffer());
    if (job !== songJob) return;
    const mono = toMono(buffer);
    state.song = {
      name,
      buffer,
      level: rms(mono),
      activations: null,
      stems: null,
      modes: { ...DEFAULT_MODES },
      ready: false,
      allNotes: [],
      edits: emptyEdits(),
    };
    $('song-meta').textContent = `${video ? '视频音轨 · ' : ''}${channels(buffer)} · ${clock(buffer.duration, 1)} · ${size(blob.size)}`;
    song.wave.setData(mono, buffer.duration);
    song.showRange();
    song.enable(true);
    $('song-pick').textContent = '更换';
    showStemControls();
    invalidate();
    songTask.stage(1);
    songTask.set('载入识别模型…', null);
    const activations = await analyse(buffer, MODEL_URL, p => {
      if (job === songJob) songTask.set('识别音符', p);
    });
    if (job !== songJob) return;
    state.song.activations = activations;
    state.song.ready = true;
    $('split').disabled = false;
    songTask.done('识别完成');
    updateNotes();
  } catch (err) {
    if (job !== songJob) return;
    console.error(err);
    songTask.fail(describe(err, video));
  }
}

$('song-reset').addEventListener('click', () => {
  song.wave.setRange(0, song.wave.duration);
  song.wave.onChange(true);
});

function describe(err, video = false) {
  if (err?.name === 'EncodingError') {
    return video ? '读不出这个视频的音轨，可能没有声音或编码不支持' : '这个文件解码不了，换成 mp3、wav 或 m4a 试试';
  }
  return `出错了：${err?.message || err}`;
}

// ---------- 拆分音轨 ----------

const QUIET = 0.03; // 比整首的平均响度低 30 dB 以上就算没有声音
const stemOwners = {};
const stemWaves = {};
let splitSupported = false;
let stemQueue = Promise.resolve();

$('stems').innerHTML = Object.entries(STEMS)
  .map(([key, label]) => {
    const options = [['convert', '转换'], ['keep', '原声'], ['drop', '静音']]
      .map(([value, text]) => `<label><input type="radio" name="stem-${key}" value="${value}"><span>${text}</span></label>`)
      .join('');
    return `<div class="stem" id="stem-${key}">
      <button class="play mini" id="stem-play-${key}" type="button" aria-label="播放${label}">${$('song-play').innerHTML}</button>
      <div class="stem-main">
        <div class="stem-head">
          <b>${label}<small>几乎无声</small></b>
          <span class="meta" id="stem-count-${key}"></span>
          <button class="btn tiny" id="stem-full-${key}" type="button" disabled>全段</button>
          <button class="btn tiny" id="stem-params-${key}" type="button">参数</button>
          <button class="btn tiny" id="stem-save-${key}" type="button">下载</button>
          <div class="seg" role="radiogroup" aria-label="${label}怎么处理">${options}</div>
        </div>
        <div class="wave lane empty" id="stem-wave-${key}">
          <canvas role="img" aria-label="${label}的波形"></canvas>
          <div class="handle" data-edge="a" role="slider" tabindex="0" aria-label="${label}起点" aria-valuemin="0"></div>
          <div class="handle" data-edge="b" role="slider" tabindex="0" aria-label="${label}终点" aria-valuemin="0"></div>
        </div>
      </div>
    </div>`;
  })
  .join('');

/** 某一轨实际起作用的时间段：它自己的选区和整首选区的交集。 */
function stemSpan(key) {
  const wave = stemWaves[key];
  return [Math.max(song.wave.a, wave.a), Math.min(song.wave.b, wave.b)];
}

for (const [key, label] of Object.entries(STEMS)) {
  const owner = (stemOwners[key] = {
    button: $(`stem-play-${key}`),
    show(t) {
      wave.playhead = t;
      wave.draw();
    },
  });
  const play = (from = stemSpan(key)[0]) => {
    const stem = state.song.stems[key];
    stem.buffer ??= monoBuffer(stem.audio);
    player.play(owner, stem.buffer, from, stemSpan(key)[1]);
  };
  // 每轨一条波形，和上面整首的波形共用同一条时间轴。两端的把手单独剪这一轨；点波形从该处试听
  const wave = (stemWaves[key] = new Wave($(`stem-wave-${key}`), {
    ruler: false,
    onChange() {
      player.stop(owner);
      $(`stem-full-${key}`).disabled = wave.a === 0 && wave.b === wave.duration;
      filterNotes();
    },
    onSeek(t) {
      const [from, to] = stemSpan(key);
      if (t >= from && t < to) play(t);
    },
  }));
  owner.button.addEventListener('click', () => player.toggle(owner, play));
  $(`stem-full-${key}`).addEventListener('click', () => {
    wave.setRange(0, wave.duration);
    wave.onChange(true);
  });
  $(`stem-params-${key}`).addEventListener('click', () => {
    selectTrack(key);
    $('params-card').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  $(`stem-save-${key}`).addEventListener('click', () =>
    saveWav(`${songBase()}-${label}`, encodeWav(state.song.stems[key].audio, SR)),
  );
  for (const radio of document.getElementsByName(`stem-${key}`)) {
    radio.addEventListener('change', () => {
      state.song.modes[key] = radio.value;
      analyseStems();
    });
  }
}

/** 拆分按钮旁边那句说明：模型多大、是不是已经下好了。 */
async function showSplitNote() {
  const info = await modelInfo();
  $('split-note').textContent = info.cached
    ? '合奏、带鼓或带人声的曲子，先拆成四轨再转，效果好得多。拆分模型已经在这个浏览器里，不用再下载。'
    : `合奏、带鼓或带人声的曲子，先拆成四轨再转，效果好得多。需要下载第三方模型（${info.size ? size(info.size) : '约 180 MB'}），点了之后会先向你确认。`;
}

stemsAvailable().then(ok => {
  splitSupported = ok;
  showStemControls();
  if (ok) showSplitNote();
});

function showStemControls() {
  const s = state.song;
  $('split-row').hidden = !splitSupported || !s || !!s.stems;
  $('stems').hidden = $('tracks').hidden = $('volume-row').hidden = !s?.stems;
  showAddTarget();
  if (!s?.stems) return;
  for (const [key, mode] of Object.entries(s.modes)) {
    document.querySelector(`input[name="stem-${key}"][value="${mode}"]`).checked = true;
    $(`stem-${key}`).classList.toggle('quiet', s.stems[key].quiet);
    $(`stem-${key}`).dataset.mode = mode; // 波形按处理方式换深浅
    stemWaves[key].draw();
  }
}

$('model-links').innerHTML = [
  [CREDITS.demucsWeb.url, 'github.com/timcsy/demucs-web（浏览器版）'],
  [MODEL_SOURCE, 'huggingface.co/timcsy/demucs-web-onnx（模型文件）'],
  [CREDITS.demucs.url, 'github.com/facebookresearch/demucs（原始项目）'],
]
  .map(([url, text]) => `<a href="${url}" target="_blank" rel="noopener">${text}</a>`)
  .join('');

$('split').addEventListener('click', async () => {
  const job = songJob;
  const s = state.song;
  // 模型不在浏览器里就要下载：先说清楚是第三方的、有多大、出处在哪，确认了才下
  const info = await modelInfo();
  if (!info.cached) {
    $('model-size').textContent = info.size ? size(info.size) : '约 180 MB';
    $('model-runtime').textContent = info.runtimeSize ? `另需 ${size(info.runtimeSize)} 的运行时（ONNX Runtime Web）` : '';
    if (!(await confirmDialog($('model-dialog'))) || job !== songJob) return;
  }
  $('split').disabled = true;
  const stageOf = { download: 0, load: 1, split: 2 };
  songTask.start(['下载模型', '载入模型', '拆分音轨', '识别各轨']);
  try {
    const { stems, backend } = await separate(s.buffer, (stage, text, p) => {
      if (job !== songJob) return;
      songTask.stage(stageOf[stage]);
      songTask.set(text, p);
    });
    if (job !== songJob) return;
    s.stems = Object.fromEntries(
      Object.entries(stems).map(([key, audio]) => [key, { audio, env: envelope(audio), activations: null }]),
    );
    // 几乎没有声音的轨（比如纯音乐里的“人声”）默认静音，省得白白识别一遍
    for (const [key, stem] of Object.entries(s.stems)) {
      stem.quiet = rms(stem.audio) < s.level * QUIET;
      if (stem.quiet) s.modes[key] = 'drop';
    }
    $('song-meta').textContent += ` · 已拆分（${backend}）`;
    // 各轨用同一个纵向比例，轻的轨看起来就是矮的
    let loudest = 0.05;
    for (const audio of Object.values(stems)) for (const v of audio) loudest = Math.max(loudest, Math.abs(v));
    for (const [key, audio] of Object.entries(stems)) {
      const wave = stemWaves[key];
      wave.reference = loudest;
      wave.clip = { a: song.wave.a, b: song.wave.b };
      wave.setData(audio, s.buffer.duration);
      // 各轨从没拆分时的那套参数起步
      state.params[key] = { ...state.params.all };
    }
    showSplitNote();
    analyseStems(true);
  } catch (err) {
    if (job !== songJob) return;
    console.error(err);
    songTask.fail(`拆分失败：${err.message}`);
    $('split').disabled = false;
  }
});

/** 给设为“转换”的各轨分别识别音符（识别过的留着不重做），完成后刷新结果。 */
function analyseStems(afterSplit = false) {
  const job = songJob;
  const s = state.song;
  s.ready = false;
  invalidate();
  showStemControls();
  stemQueue = stemQueue
    .then(async () => {
      if (job !== songJob) return;
      const pending = STEM_KEYS.filter(key => s.modes[key] === 'convert' && !s.stems[key].activations);
      if (pending.length) {
        if (afterSplit) songTask.stage(3);
        else songTask.start(['识别各轨']);
      }
      for (const [index, key] of pending.entries()) {
        if (job !== songJob) return;
        if (s.modes[key] !== 'convert' || s.stems[key].activations) continue;
        s.stems[key].activations = await analyse(monoBuffer(s.stems[key].audio), MODEL_URL, p => {
          if (job === songJob) songTask.set(`识别${STEMS[key]}（${index + 1} / ${pending.length}）`, (index + p) / pending.length);
        });
      }
      // 排队期间处理方式可能又改了，还有没识别的就留给后面那次收尾
      if (job !== songJob || STEM_KEYS.some(key => s.modes[key] === 'convert' && !s.stems[key].activations)) return;
      songTask.done(afterSplit ? '拆分完成' : '识别完成');
      s.ready = true;
      updateNotes();
    })
    .catch(err => {
      console.error(err);
      if (job === songJob) songTask.fail(describe(err));
    });
}

// ---------- 声音 ----------

const sample = track('sample', () => state.sample, final => final && updateCut());

async function loadSample(blob, name) {
  const job = ++sampleJob;
  const video = isVideo(blob, name);
  player.stop();
  state.sample = state.cut = null;
  $('sample-name').textContent = name;
  $('sample-meta').textContent = '';
  sample.clear();
  $('denoise').disabled = true;
  $('sample-pitch').textContent = $('sample-floor').textContent = $('stat-pitch').textContent = '–';
  sampleTask.start();
  sampleTask.set(video ? '从视频里取出音轨…' : '解码中…', null);
  invalidate();
  try {
    const buffer = await decode(await blob.arrayBuffer());
    if (job !== sampleJob) return;
    const mono = toMono(buffer);
    const bounds = soundBounds(mono).map(i => i / SR);
    state.sample = { name, original: buffer, raw: mono, buffer, mono, bounds };
    const floor = noiseFloorDb(mono);
    $('sample-floor').textContent = floor === null ? '–' : `${floor} dB`;
    $('denoise').disabled = false;
    $('sample-meta').textContent = `${video ? '视频音轨 · ' : ''}${channels(buffer)} · ${clock(buffer.duration)} · ${size(blob.size)}`;
    sample.wave.setData(mono, buffer.duration, ...bounds);
    sample.showRange();
    sample.enable(true);
    $('sample-pick').textContent = '更换';
    sampleTask.set('分析音高…', 0.7);
    applyDenoise();
    sampleTask.done('载入完成');
  } catch (err) {
    if (job !== sampleJob) return;
    console.error(err);
    sampleTask.fail(describe(err, video));
  }
}

$('sample-reset').addEventListener('click', () => {
  sample.wave.setRange(...state.sample.bounds);
  sample.wave.onChange(true);
});

/** 按“降噪”滑杆处理整段声音；波形、试听和后面的截取都用处理后的。 */
function applyDenoise() {
  const s = state.sample;
  if (!s) return;
  const strength = +$('denoise').value;
  s.mono = denoise(s.raw, strength);
  s.buffer = strength ? monoBuffer(s.mono) : s.original;
  s.bounds = soundBounds(s.mono).map(i => i / SR); // 底噪压下去之后，“去静音”能裁得更贴
  sample.wave.setSamples(s.mono);
  updateCut();
}

let denoiseTimer;
function paintDenoise() {
  const v = +$('denoise').value;
  $('denoise').style.setProperty('--hi', `${v * 100}%`);
  $('denoise-out').textContent = v ? `${Math.round(v * 100)}%` : '关';
  $('denoise-reset').disabled = !v;
}
$('denoise').addEventListener('input', () => {
  paintDenoise();
  player.stop(sample.owner);
  clearTimeout(denoiseTimer);
  denoiseTimer = setTimeout(applyDenoise, 80);
});
$('denoise-reset').addEventListener('click', () => {
  $('denoise').value = 0;
  $('denoise').dispatchEvent(new Event('input'));
});
paintDenoise();

function updateCut() {
  if (!state.sample) return;
  const { a, b } = sample.wave;
  state.cut = cutSample(state.sample.mono, Math.round(a * SR), Math.round(b * SR));
  state.cutId++;
  const detected = detectRoot(state.cut);
  state.root = detected ?? 60;
  $('sample-pitch').textContent =
    detected === null ? '不明' : `${noteName(Math.round(detected))} · ${Math.round(440 * 2 ** ((detected - 69) / 12))} Hz`;
  $('stat-pitch').textContent = detected === null ? '–' : noteName(Math.round(detected));
  showSteps();
  redraw();
}

// ---------- 选文件 ----------

function bindPicker(prefix, load) {
  const input = $(`${prefix}-file`);
  const card = $(`${prefix}-card`);
  input.addEventListener('change', () => {
    if (input.files[0]) load(input.files[0], input.files[0].name);
    input.value = '';
  });
  card.addEventListener('dragover', e => {
    e.preventDefault();
    card.classList.add('over');
  });
  card.addEventListener('dragleave', () => card.classList.remove('over'));
  card.addEventListener('drop', e => {
    e.preventDefault();
    card.classList.remove('over');
    const file = e.dataTransfer.files[0];
    if (file) load(file, file.name);
  });
}
bindPicker('song', loadSong);
bindPicker('sample', (blob, name) => {
  // 用了自己的文件，内置声音就都不选中
  for (const radio of document.getElementsByName('preset')) radio.checked = false;
  loadSample(blob, name);
});

// 内置的声音：点一下就换
$('presets').innerHTML = PRESETS.map(
  (preset, index) => `<label><input type="radio" name="preset" value="${index}"><span>${preset.name}</span></label>`,
).join('');

async function loadPreset(index) {
  const preset = PRESETS[index];
  document.querySelector(`input[name="preset"][value="${index}"]`).checked = true;
  const job = ++sampleJob; // 先占住，连点两个时只有后一个生效
  try {
    const res = await fetch(preset.url);
    if (!res.ok) throw new Error(`${preset.name} 没有加载成功（${res.status}）`);
    const blob = await res.blob();
    if (job === sampleJob) loadSample(blob, preset.name);
  } catch (err) {
    console.error(err);
    if (job === sampleJob) sampleTask.fail(describe(err));
    showSteps();
  }
}
for (const radio of document.getElementsByName('preset')) {
  radio.addEventListener('change', () => loadPreset(+radio.value));
}

// ---------- 参数 ----------

const RANGE_MAX = 36; // “音域”滑杆拉过这个值就是不限制
const rangeOf = params => (params.range > RANGE_MAX ? Infinity : params.range);

function redraw() {
  roll.draw();
  scheduleRender();
}

const controls = {
  pitch: {
    onInput: redraw,
    text: v => `${v > 0 ? '+' : ''}${v} 半音`,
  },
  density: {
    onInput: updateNotes,
    text() {
      if (!state.song?.ready) return '–';
      const count = state.track === 'all' ? state.notes.length : state.notes.filter(n => n.stem === state.track).length;
      return `${count} 个音符`;
    },
  },
  release: {
    onInput: scheduleRender,
    text: v => `${Math.round(v * 1000)} ms`,
  },
  range: {
    onInput: redraw,
    text: v => (v > RANGE_MAX ? '不限' : `±${v} 半音`),
  },
  volume: {
    onInput: scheduleRender,
    text: v => `${Math.round(v * 100)}%`,
  },
};

function paintControl(id) {
  const input = $(id);
  const pos = ((input.value - input.min) / (input.max - input.min)) * 100;
  // 音高是双向的，从中点往两边填色；其余从左端填起
  const origin = id === 'pitch' ? 50 : 0;
  input.style.setProperty('--lo', `${Math.min(origin, pos)}%`);
  input.style.setProperty('--hi', `${Math.max(origin, pos)}%`);
  $(`${id}-out`).textContent = controls[id].text(+input.value);
  $(`${id}-reset`).disabled = input.value === input.defaultValue;
}

for (const [id, control] of Object.entries(controls)) {
  $(id).addEventListener('input', () => {
    // 选着“全部”时，每一轨都跟着改
    const targets = state.track === 'all' ? Object.values(state.params) : [state.params[state.track]];
    for (const params of targets) params[id] = +$(id).value;
    control.onInput();
    paintControl(id);
  });
  $(`${id}-reset`).addEventListener('click', () => {
    $(id).value = $(id).defaultValue;
    $(id).dispatchEvent(new Event('input'));
  });
}

const swatch = key => `<i class="sw-${key}"></i>`;
$('tracks').innerHTML =
  '<label><input type="radio" name="track" value="all" checked><span>全部</span></label>' +
  Object.entries(STEMS)
    .map(([key, label]) => `<label><input type="radio" name="track" value="${key}"><span>${swatch(key)}${label}</span></label>`)
    .join('');
for (const radio of document.getElementsByName('track')) {
  radio.addEventListener('change', () => selectTrack(radio.value));
}

/** 把参数面板切到某一轨（或“全部”），滑杆显示这一轨的数值。 */
function selectTrack(key) {
  state.track = key;
  document.querySelector(`input[name="track"][value="${key}"]`).checked = true;
  for (const id of PARAM_IDS) {
    $(id).value = state.params[key][id];
    paintControl(id);
  }
}
selectTrack('all');

// ---------- 音符 ----------

function updateNotes() {
  const s = state.song;
  if (!s?.ready) return;
  // 一个滑杆同时控制两个阈值：越往右阈值越低，识别出的音符越多。
  // 起音阈值放得慢一些：它一低，还在延续的音就容易被重复触发
  const notesOf = (activations, amount) => {
    const a = Math.min(1, amount);
    return extract(activations, 0.9 - 0.4 * a, 0.6 - 0.45 * a);
  };
  const stemNotes = (key, stem) => {
    const { boost, mono } = STEM_TUNING[key];
    const notes = gateNotes(notesOf(stem.activations, state.params[key].density + boost), stem.env, s.level * QUIET);
    return (mono ? monophonic(notes) : notes).map(n => ({ ...n, stem: key }));
  };
  s.allNotes = s.stems
    ? mergeNotes(STEM_KEYS.filter(key => s.modes[key] === 'convert').map(key => stemNotes(key, s.stems[key])))
    : notesOf(s.activations, state.params.all.density);
  filterNotes();
}

// 手工删掉的音符靠这个标识认出来；重新识别后，同一轨、同音高、同位置的音仍然算是它
const noteKey = n => `${n.stem ?? ''}|${n.pitch}|${Math.round(n.start * 20)}`;

/** 从识别结果和手工改动得出选区内最终要发声的音符。 */
function filterNotes() {
  const s = state.song;
  if (!s?.ready) return;
  const { a } = song.wave;
  const live = n => !n.stem || s.modes[n.stem] === 'convert';
  state.notes = [];
  for (const n of [...s.allNotes.filter(n => !s.edits.removed.has(noteKey(n))), ...s.edits.added.filter(live)]) {
    const [from, to] = n.stem ? stemSpan(n.stem) : [a, song.wave.b];
    if (n.start >= from && n.start < to) {
      state.notes.push({ ...n, start: n.start - a, dur: Math.min(n.dur, to - n.start), src: n });
    }
  }
  state.notes.sort((p, q) => p.start - q.start);
  $('out-empty').hidden = true; // 识别完了，编辑器可以用了
  $('stat-notes').textContent = state.notes.length;
  for (const key of STEM_KEYS) {
    const converting = s.stems && s.modes[key] === 'convert';
    $(`stem-count-${key}`).textContent = converting ? `${state.notes.filter(n => n.stem === key).length} 个音` : '';
  }
  paintControl('density');
  showEdits();
  redraw();
}

// ---------- 结果 ----------

const renderCache = new Map(); // 轨名 -> { signature, audio }，没变的轨不用重新渲染
const outOwner = {
  button: $('out-play'),
  show(t) {
    roll.draw(t);
    showOutTime(t);
  },
};

function rollSpan() {
  return Math.max(song.wave.b - song.wave.a, state.out?.buffer.duration || 0) || 1;
}

/** 音符实际发出来的音高：先按所在轨移调，再按“音域”折回。 */
function shown(note) {
  const params = paramsFor(note);
  const moved = note.pitch + params.pitch;
  return moved + Math.round(octaveFold(moved - state.root, rangeOf(params)) - (moved - state.root));
}

function showOutTime(t = null) {
  const total = state.out?.buffer.duration;
  $('out-time').textContent = total ? `${clock(t ?? 0, 1)} / ${clock(total, 1)}` : '';
}

function invalidate() {
  renderJob++;
  clearTimeout(renderTimer);
  player.stop(outOwner);
  outTask.hide();
  state.out = null;
  $('out-play').disabled = $('save').disabled = true;
  const s = state.song;
  // 识别完之后编辑器就能用了，哪怕暂时没有可播放的结果；这时把原因写在下面
  $('out-empty').hidden = !!s?.ready;
  $('out-empty-text').textContent = !s ? '选好曲子后，识别出的音符会出现在这里' : s.stems ? '正在识别各轨的音符…' : '正在识别音符…';
  $('out-info').textContent = !s?.ready
    ? ''
    : s.stems && Object.values(s.modes).every(mode => mode === 'drop')
      ? '四轨都静音了，没有声音可以输出'
      : !state.notes.length
        ? '没有音符：把“音符”滑杆往右拉，或者用“添加”工具自己加'
        : '还差一段声音';
  $('save-note').textContent = '';
  $('stat-out').textContent = '–';
  if (!s?.ready) $('stat-notes').textContent = '–';
  showOutTime();
  showSteps();
  roll.draw(null);
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderNow, 200);
}

/** 渲染一组音符；音符、参数和采样都没变时直接用上次的结果。 */
async function renderGroup(key, notes) {
  const params = state.params[key];
  let sum = 0;
  for (const n of notes) sum += n.start * 1000 + n.dur * 100 + n.pitch * 7 + n.amp;
  const signature = [notes.length, Math.round(sum), params.pitch, params.release, params.range, state.root, state.cutId].join('|');
  const cached = renderCache.get(key);
  if (cached?.signature === signature) return cached.audio;
  const audio = await render(notes, state.cut, state.root, {
    transpose: params.pitch,
    release: params.release,
    range: rangeOf(params),
  });
  renderCache.set(key, { signature, audio });
  return audio;
}

async function renderNow() {
  const s = state.song;
  if (!s?.ready) return invalidate();
  // 设为“原声”的轨：原样取出各自起作用的那一段
  const kept = [];
  for (const key of s.stems ? STEM_KEYS : []) {
    const [from, to] = stemSpan(key);
    if (s.modes[key] === 'keep' && to > from) {
      kept.push({ audio: fadedSlice(s.stems[key].audio, from, to), at: from - song.wave.a, gain: state.params[key].volume });
    }
  }
  // 要转换的音符按轨分组，每轨用自己的参数
  const groups = new Map();
  for (const n of state.cut ? state.notes : []) {
    const key = n.stem ?? 'all';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  if (!groups.size && !kept.length) return invalidate();

  const job = ++renderJob;
  const converted = [];
  outTask.start();
  try {
    let index = 0;
    for (const [key, notes] of groups) {
      outTask.set(groups.size > 1 ? `合成${STEMS[key] ?? ''}（${index + 1} / ${groups.size}）` : `合成 ${notes.length} 个音符`, index / groups.size);
      const audio = await renderGroup(key, notes);
      if (job !== renderJob) return;
      converted.push({ audio, at: 0, gain: s.stems ? state.params[key].volume : 1 });
      index++;
    }
  } catch (err) {
    console.error(err);
    if (job === renderJob) outTask.fail(describe(err));
    return;
  }
  outTask.set('混音', 0.95);
  player.stop(outOwner);
  // 转换出的各轨先合在一起定好音量，再和原声混，这样两边的响度比例不随曲子变
  const lead = sumParts(converted);
  const audio = kept.length
    ? normalize(sumParts([{ audio: normalize(lead, 0.71), at: 0, gain: 1 }, ...kept]))
    : normalize(lead);
  const buffer = monoBuffer(audio);
  state.out = { wav: encodeWav(audio, SR), buffer };
  $('out-play').disabled = $('save').disabled = false;
  $('out-info').textContent = `WAV · 44.1 kHz · 16 bit · 单声道 · ${size(state.out.wav.length)}`;
  $('save-note').textContent = '';
  $('stat-out').textContent = clock(buffer.duration, 1);
  outTask.done('已生成');
  showOutTime();
  showSteps();
  roll.draw(null);
}

function playResult(from = 0) {
  player.play(outOwner, state.out.buffer, from, state.out.buffer.duration);
}
$('out-play').addEventListener('click', () => player.toggle(outOwner, playResult));

$('save').addEventListener('click', async () => {
  if (state.out && (await saveWav(`🧊-${songBase()}`, state.out.wav)) && (await downloads)) {
    $('save-note').textContent = '已保存';
  }
});

// ---------- 音符编辑器 ----------

const MIN_NOTE = 0.1; // 手工添加的音符最短这么多秒

const roll = createRoll($('roll'), {
  ready: () => !!state.song?.ready,
  notes: () => state.notes,
  span: rollSpan,
  shown,
  color: stem => (stem ? `--stem-${stem}` : '--accent'),
  newStem: addTarget,
  center: () => Math.round(state.root),
  seek: t => state.out && playResult(Math.max(0, Math.min(t, state.out.buffer.duration - 0.05))),
  add: addNote,
  remove: notes => commit(removal(notes.map(n => n.src))),
  change: changeNote,
  preview,
  status: text => ($('edit-pos').textContent = text),
  viewChanged: showView,
});

/** 放一声采样，听听这个音高是什么样。 */
let previewSample = { id: -1, buffer: null };
function preview(pitch) {
  if (!$('audition').checked || !state.cut) return;
  const ctx = player.context();
  if (previewSample.id !== state.cutId) previewSample = { id: state.cutId, buffer: monoBuffer(state.cut) };
  const node = ctx.createBufferSource();
  node.buffer = previewSample.buffer;
  node.playbackRate.value = 2 ** ((pitch - state.root) / 12);
  const gain = ctx.createGain();
  gain.gain.value = 0.5;
  gain.gain.setTargetAtTime(0, ctx.currentTime + 0.35, 0.08);
  node.connect(gain).connect(ctx.destination);
  node.start();
  node.stop(ctx.currentTime + 0.9);
}

/** 新加的音符归到哪一轨：工具栏里选的那轨，否则第一条在转换的轨；没拆分时不分轨。 */
function addTarget() {
  const s = state.song;
  if (!s?.stems) return undefined;
  const converting = STEM_KEYS.filter(key => s.modes[key] === 'convert');
  return converting.includes(state.addStem) ? state.addStem : converting[0] ?? null;
}

$('add-target').innerHTML = Object.entries(STEMS)
  .map(([key, label]) => `<label data-stem="${key}"><input type="radio" name="add-target" value="${key}"><span>${swatch(key)}${label}</span></label>`)
  .join('');
for (const radio of document.getElementsByName('add-target')) {
  radio.addEventListener('change', () => (state.addStem = radio.value));
}

function showAddTarget() {
  const s = state.song;
  $('add-target-box').hidden = !s?.stems;
  if (!s?.stems) return;
  for (const label of $('add-target').children) label.hidden = s.modes[label.dataset.stem] !== 'convert';
  const target = addTarget();
  if (target) document.querySelector(`input[name="add-target"][value="${target}"]`).checked = true;
}

// 每次改动记成一步：hide 是被藏起来的识别音符，drop 是被拿掉的手工音符，add 是新放进去的手工音符
function applyStep(step, forward) {
  const { removed, added } = state.song.edits;
  for (const key of step.hide) forward ? removed.add(key) : removed.delete(key);
  for (const note of forward ? step.drop : step.add) added.splice(added.indexOf(note), 1);
  added.push(...(forward ? step.add : step.drop));
}

function commit(step) {
  const { edits } = state.song;
  const full = { hide: [], drop: [], add: [], ...step };
  applyStep(full, true);
  edits.history.push(full);
  edits.future.length = 0;
  filterNotes();
}

/** 去掉这些音符需要的那一步。 */
const removal = notes => ({
  hide: notes.filter(n => !n.added).map(noteKey),
  drop: notes.filter(n => n.added),
});

function addNote(from, to, pitch) {
  const stem = addTarget();
  commit({
    add: [{
      start: song.wave.a + Math.min(from, to),
      dur: Math.max(MIN_NOTE, Math.abs(to - from)),
      pitch: pitch - state.params[stem ?? 'all'].pitch, // 编辑器里显示的是移调后的音高，存的是移调前的
      amp: 0.85,
      added: true,
      ...(stem && { stem }),
    }],
  });
}

/** 移动或拉长一个音符：把原来的去掉，换成改过的。 */
function changeNote(shownNote, dt, dPitch, dDur) {
  const { src } = shownNote;
  const changed = {
    start: Math.max(0, src.start + dt),
    dur: Math.max(MIN_NOTE, src.dur + dDur),
    pitch: src.pitch + dPitch,
    amp: src.amp,
    added: true,
    ...(src.stem && { stem: src.stem }),
  };
  commit({ ...removal([src]), add: [changed] });
}

function undo() {
  const edits = state.song?.edits;
  const step = edits?.history.pop();
  if (!step) return;
  applyStep(step, false);
  edits.future.push(step);
  filterNotes();
}

function redo() {
  const edits = state.song?.edits;
  const step = edits?.future.pop();
  if (!step) return;
  applyStep(step, true);
  edits.history.push(step);
  filterNotes();
}

/** 刷新撤销、重做这些按钮和“已改几处”。 */
function showEdits() {
  const edits = state.song?.edits;
  const count = edits ? edits.removed.size + edits.added.length : 0;
  $('undo').disabled = !edits?.history.length;
  $('redo').disabled = !edits?.future.length;
  $('restore').disabled = !count;
  $('edit-count').textContent = count ? `已改 ${count} 处` : '';
}

$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
$('restore').addEventListener('click', () => {
  state.song.edits = emptyEdits();
  filterNotes();
});

function setTool(tool) {
  document.querySelector(`input[name="tool"][value="${tool}"]`).checked = true;
  roll.setTool(tool);
}
for (const radio of document.getElementsByName('tool')) {
  radio.addEventListener('change', () => roll.setTool(radio.value));
}

/** 缩放和滚动条跟着编辑器的画面走。 */
function showView() {
  const { zoom } = roll.view;
  $('zoom-label').textContent = `${zoom < 10 ? zoom.toFixed(1).replace('.0', '') : Math.round(zoom)}×`;
  $('zoom-out').disabled = $('zoom-fit').disabled = zoom <= 1;
  $('roll-scroll').hidden = zoom <= 1;
  $('roll-scroll').value = roll.scrolled * 1000;
}
$('zoom-in').addEventListener('click', () => roll.zoomBy(1.6));
$('zoom-out').addEventListener('click', () => roll.zoomBy(1 / 1.6));
$('zoom-fit').addEventListener('click', () => roll.fit());
$('roll-scroll').addEventListener('input', () => roll.scrollTo($('roll-scroll').value / 1000));
showView();

// 快捷键：空格播放 / 停止，V B E M 切换工具，⌘Z / Ctrl+Z 撤销，⇧⌘Z / Ctrl+Y 重做
document.addEventListener('keydown', e => {
  const target = e.target instanceof Element ? e.target : document.body;
  if ($('model-dialog').open || target.closest('textarea, select, input:not([type="range"], [type="radio"], [type="checkbox"])')) return;
  const key = e.key.toLowerCase();
  if (e.metaKey || e.ctrlKey) {
    if (key !== 'z' && key !== 'y') return;
    e.preventDefault();
    if (key === 'y' || e.shiftKey) redo();
    else undo();
    return;
  }
  if (e.altKey) return;
  const tool = { v: 'seek', b: 'draw', e: 'erase', m: 'move' }[key];
  if (tool) return setTool(tool);
  if (e.key === ' ' && state.out && !target.closest('button, input, label, a, [role="slider"]')) {
    e.preventDefault();
    player.toggle(outOwner, playResult);
  }
});

// ---------- 页脚 ----------

if (PROJECT_URL) {
  $('repo-link').href = $('footer-repo-link').href = PROJECT_URL;
  $('footer-repo-link').textContent = PROJECT_URL.replace(/^https?:\/\//, '');
  $('repo-link').hidden = $('footer-repo').hidden = false;
}
$('credits').innerHTML = Object.values(CREDITS)
  .map(c => `<a href="${c.url}" target="_blank" rel="noopener">${c.name}<span>${c.by} · ${c.license} · ${c.use}</span></a>`)
  .join('');

// ---------- 启动 ----------

showEdits();
showSteps();
loadPreset(0);
