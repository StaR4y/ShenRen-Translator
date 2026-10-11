"""把一段音乐的音色换成一个短采样的音色。

流程：音频 -> 音符（basic-pitch 转谱）-> 把采样变调到每个音符 -> 按时间叠加。

用法：
    python timbre_swap.py song.wav sample.wav -o out.wav
"""

import argparse

import librosa
import numpy as np
import soundfile as sf

SR = 44100


def transcribe(path, onset_threshold=0.5, frame_threshold=0.3, min_note_ms=60):
    """返回 [(start_s, end_s, midi_pitch, amplitude)]，按开始时间排序。"""
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import predict

    _, _, events = predict(
        path,
        ICASSP_2022_MODEL_PATH,
        onset_threshold=onset_threshold,
        frame_threshold=frame_threshold,
        minimum_note_length=min_note_ms,
    )
    notes = [(float(s), float(e), int(p), float(a)) for s, e, p, a, _ in events]
    return sorted(notes)


def load_sample(path):
    y, _ = librosa.load(path, sr=SR, mono=True)
    y, _ = librosa.effects.trim(y, top_db=40)  # 去掉首尾静音，保证起音对齐
    return y / (np.max(np.abs(y)) + 1e-9)


def detect_root(y):
    """估计采样的基准音高（MIDI 音符号，可带小数）。"""
    f0, voiced, prob = librosa.pyin(
        y, sr=SR, fmin=librosa.note_to_hz("C2"), fmax=librosa.note_to_hz("C7")
    )
    f0 = f0[voiced & (prob > 0.5)]
    if len(f0) == 0:
        raise SystemExit("检测不到采样的音高，请用 --root 手动指定（如 --root A3）")
    return float(np.median(librosa.hz_to_midi(f0)))


def shift(y, semitones, mode):
    if abs(semitones) < 1e-3:
        return y
    if mode == "preserve":
        # 相位声码器：时长不变，但瞬态会变糊
        return librosa.effects.pitch_shift(y, sr=SR, n_steps=semitones)
    # 变速变调：音质最干净，高音会变短、低音会变长
    ratio = 2 ** (semitones / 12)
    return librosa.resample(y, orig_sr=SR * ratio, target_sr=SR)


def render(notes, sample, root, mode="resample", release=0.12, transpose=0):
    total = max(e for _, e, _, _ in notes) + len(sample) / SR * 4 + release
    out = np.zeros(int(total * SR), dtype=np.float32)
    peak_amp = max(a for *_, a in notes)
    cache = {}

    for start, end, pitch, amp in notes:
        pitch += transpose
        if pitch not in cache:
            cache[pitch] = shift(sample, pitch - root, mode)
        voice = cache[pitch]

        # 音符比采样短：在音符结束处淡出；比采样长：让采样自然放完
        n_hold = int((end - start) * SR)
        n_rel = int(release * SR)
        if n_hold + n_rel < len(voice):
            voice = voice[: n_hold + n_rel].copy()
            voice[n_hold:] *= np.linspace(1, 0, n_rel)

        i = int(start * SR)
        gain = 0.25 + 0.75 * amp / peak_amp
        out[i : i + len(voice)] += gain * voice[: len(out) - i]

    out = np.trim_zeros(out, "b")
    return 0.89 * out / (np.max(np.abs(out)) + 1e-9)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("song", help="要被替换音色的音乐")
    ap.add_argument("sample", help="目标音色采样（建议 1 秒以内、有明确音高）")
    ap.add_argument("-o", "--out", default="out.wav")
    ap.add_argument("--root", help="采样的基准音高，如 A3；不填则自动检测")
    ap.add_argument("--mode", choices=["resample", "preserve"], default="resample",
                    help="resample=变速变调（默认），preserve=保持采样时长")
    ap.add_argument("--transpose", type=int, default=0, help="整体移调（半音）")
    ap.add_argument("--release", type=float, default=0.12, help="音符结束后的淡出秒数")
    ap.add_argument("--onset", type=float, default=0.5,
                    help="起音阈值 0~1，调高可减少多余的音符（默认 0.5）")
    ap.add_argument("--frame", type=float, default=0.3,
                    help="持续音阈值 0~1，调高可减少多余的音符（默认 0.3）")
    ap.add_argument("--midi", help="同时把转谱结果存成 MIDI")
    args = ap.parse_args()

    notes = transcribe(args.song, args.onset, args.frame)
    if not notes:
        raise SystemExit("没有从音乐里识别出音符")
    print(f"识别出 {len(notes)} 个音符")

    sample = load_sample(args.sample)
    root = librosa.note_to_midi(args.root) if args.root else detect_root(sample)
    print(f"采样基准音高：{librosa.midi_to_note(round(root))}（MIDI {root:.2f}）")

    sf.write(args.out, render(notes, sample, root, args.mode, args.release, args.transpose), SR)
    print(f"已写出 {args.out}")

    if args.midi:
        import pretty_midi

        pm = pretty_midi.PrettyMIDI()
        inst = pretty_midi.Instrument(program=0)
        for s, e, p, a in notes:
            inst.notes.append(pretty_midi.Note(int(40 + 87 * a), p, s, e))
        pm.instruments.append(inst)
        pm.write(args.midi)


if __name__ == "__main__":
    main()
