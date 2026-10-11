// 文件格式编码：16 位单声道 WAV，以及只含一个文件的 zip。

export function encodeWav(samples, sampleRate) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (off, s) => [...s].forEach((c, i) => view.setUint8(off + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(view.buffer);
}

/** 只存储不压缩的单文件 zip。 */
export function zipSingle(name, data) {
  const crcTable = new Uint32Array(256).map((_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n;
  });
  let crc = ~0;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  crc = ~crc >>> 0;

  const nameBytes = new TextEncoder().encode(name);
  const header = (signature, extra) => {
    const h = new DataView(new ArrayBuffer(extra ? 46 : 30));
    let o = 0;
    const u16 = v => (h.setUint16(o, v, true), (o += 2));
    const u32 = v => (h.setUint32(o, v, true), (o += 4));
    u32(signature);
    if (extra) u16(20); // 创建版本
    u16(20); // 解压所需版本
    u16(0x0800); // 文件名为 UTF-8
    u16(0); // 不压缩
    u16(0); // 时间
    u16(33); // 日期 1980-01-01
    u32(crc);
    u32(data.length);
    u32(data.length);
    u16(nameBytes.length);
    u16(0);
    return new Uint8Array(h.buffer);
  };
  const local = header(0x04034b50, false);
  const central = header(0x02014b50, true);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, 1, true);
  eocd.setUint16(10, 1, true);
  eocd.setUint32(12, central.length + nameBytes.length, true);
  eocd.setUint32(16, local.length + nameBytes.length + data.length, true);
  return new Blob([local, nameBytes, data, central, nameBytes, eocd]);
}
