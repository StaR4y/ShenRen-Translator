"""合成演示素材：一段钢琴音色的《致爱丽丝》开头，和一个 0.6 秒的"啊"声采样。"""

import json
import os

import librosa
import numpy as np
import soundfile as sf

SR = 44100
STEP = 0.21  # 一个十六分音符的秒数

# (起始位置, 时值, 音名)，单位为十六分音符
RH = [
    (0, 1, "E5"), (1, 1, "D#5"),
    (2, 1, "E5"), (3, 1, "D#5"), (4, 1, "E5"), (5, 1, "B4"), (6, 1, "D5"), (7, 1, "C5"),
    (8, 2, "A4"), (11, 1, "C4"), (12, 1, "E4"), (13, 1, "A4"),
    (14, 2, "B4"), (17, 1, "E4"), (18, 1, "G#4"), (19, 1, "B4"),
    (20, 2, "C5"), (23, 1, "E4"), (24, 1, "E5"), (25, 1, "D#5"),
    (26, 1, "E5"), (27, 1, "D#5"), (28, 1, "E5"), (29, 1, "B4"), (30, 1, "D5"), (31, 1, "C5"),
    (32, 2, "A4"), (35, 1, "C4"), (36, 1, "E4"), (37, 1, "A4"),
    (38, 2, "B4"), (41, 1, "E4"), (42, 1, "C5"), (43, 1, "B4"),
    (44, 6, "A4"),
]
LH = [
    (8, 1, "A2"), (9, 1, "E3"), (10, 4, "A3"),
    (14, 1, "E2"), (15, 1, "E3"), (16, 4, "G#3"),
    (20, 1, "A2"), (21, 1, "E3"), (22, 4, "A3"),
    (32, 1, "A2"), (33, 1, "E3"), (34, 4, "A3"),
    (38, 1, "E2"), (39, 1, "E3"), (40, 4, "G#3"),
    (44, 1, "A2"), (45, 1, "E3"), (46, 4, "A3"),
]


def piano_note(freq, dur, vel):
    """加法合成的钢琴音：略带非谐性的泛音，高次泛音衰减更快。"""
    t = np.arange(int((dur + 1.2) * SR)) / SR
    y = np.zeros_like(t)
    for k in range(1, 16):
        fk = k * freq * np.sqrt(1 + 0.0004 * k * k)
        if fk > SR / 2:
            break
        decay = (1.2 + 0.5 * k) * (freq / 220) ** 0.4
        y += np.sin(2 * np.pi * fk * t) * np.exp(-decay * t) / k**1.3
    y *= np.minimum(t / 0.004, 1)
    # 松键后的制音
    off = np.clip((t - dur) / 0.15, 0, 1)
    return vel * y * (1 - off) ** 2


def voice_sample(freq=220.0, dur=0.6):
    """共振峰加法合成的"啊"声，带一点颤音。"""
    t = np.arange(int(dur * SR)) / SR
    vib = 0.25 * np.clip((t - 0.15) / 0.2, 0, 1) * np.sin(2 * np.pi * 5.5 * t)
    phase = 2 * np.pi * np.cumsum(freq * 2 ** (vib / 12)) / SR
    formants = [(800, 90, 1.0), (1150, 100, 0.6), (2900, 150, 0.25)]
    y = np.zeros_like(t)
    for k in range(1, 40):
        fk = k * freq
        gain = sum(a / (1 + ((fk - f) / bw) ** 2) for f, bw, a in formants) + 0.02 / k
        y += gain * np.sin(k * phase)
    env = np.minimum(t / 0.03, 1) * np.minimum((dur - t) / 0.15, 1)
    return 0.8 * y * env / np.max(np.abs(y))


def main():
    os.makedirs("demo", exist_ok=True)
    events = [(p, d, n, 0.9) for p, d, n in RH] + [(p, d, n, 0.6) for p, d, n in LH]
    out = np.zeros(int((52 * STEP + 2) * SR))
    truth = []
    for pos, dur, name, vel in events:
        y = piano_note(librosa.note_to_hz(name), dur * STEP * 1.6, vel)
        i = int((0.1 + pos * STEP) * SR)
        out[i : i + len(y)] += y[: len(out) - i]
        truth.append((round(0.1 + pos * STEP, 3), int(librosa.note_to_midi(name))))
    sf.write("demo/piano.wav", 0.8 * out / np.max(np.abs(out)), SR)
    sf.write("demo/sample.wav", voice_sample(), SR)
    with open("demo/truth.json", "w") as f:
        json.dump(sorted(truth), f)


if __name__ == "__main__":
    main()
