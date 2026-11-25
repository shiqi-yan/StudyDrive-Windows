const controls = /[\u0000-\u0008\u000B\u000E-\u001F\u007F-\u009F]/u;
const han = /\p{Script=Han}/u;
const binary = () => new Error('文件含有二进制数据，无法按文本预览。');
const invalid = () => new Error('无法按所选编码读取。请尝试 GB18030、GBK 或 UTF-16，也可重试获取原件。');
const has = (bytes, signature, offset = 0) => signature.every((value, index) => bytes[offset + index] === value);

function hasBinarySignature(bytes) {
  const pe = bytes.length >= 64 && has(bytes, [0x4d, 0x5a]) &&
    has(bytes, [0x50, 0x45, 0, 0], new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(60, true));
  return has(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]) || // PDF
    has(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    has(bytes, [0xff, 0xd8, 0xff]) || has(bytes, [0x50, 0x4b, 0x03, 0x04]) || has(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    has(bytes, [0xd0, 0xcf, 0x11, 0xe0]) || has(bytes, [0x1f, 0x8b, 0x08]) ||
    has(bytes, [0x7f, 0x45, 0x4c, 0x46]) || has(bytes, [0x66, 0x74, 0x79, 0x70], 4) || pe;
}

function utf16Layout(bytes) {
  const zero = [0, 0];
  const newline = [0, 0];
  const sample = Math.min(8192, bytes.length) & ~1;
  for (let index = 0; index < sample; index += 2) {
    const left = bytes[index];
    const right = bytes[index + 1];
    if (left === 0) {
      zero[0] += 1;
      if (right === 10) newline[0] += 1;
    }
    if (right === 0) {
      zero[1] += 1;
      if (left === 10) newline[1] += 1;
    }
  }
  if (sample < 8) return '';
  function evidence(side) {
    const other = 1 - side;
    return zero[side] >= 4 && zero[side] >= (zero[other] + 1) * 4 ||
      newline[side] >= 2 && newline[other] === 0;
  }
  const le = evidence(1);
  const be = evidence(0);
  return le === be ? '' : le ? 'utf-16le' : 'utf-16be';
}

function decodeText(bytes, requested, truncated) {
  if (hasBinarySignature(bytes)) throw binary();
  const read = encoding => {
    try { return new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: truncated }); }
    catch { return null; }
  };
  const withEncoding = encoding => {
    const text = read(encoding);
    if (text === null) throw invalid();
    if (controls.test(text)) throw binary();
    return { text, encoding };
  };
  if (requested !== 'auto') return withEncoding(requested);
  if (has(bytes, [0xef, 0xbb, 0xbf])) return withEncoding('utf-8');
  if (has(bytes, [0xff, 0xfe])) return withEncoding('utf-16le');
  if (has(bytes, [0xfe, 0xff])) return withEncoding('utf-16be');

  const utf8 = read('utf-8');
  if (utf8 !== null && !controls.test(utf8)) return { text: utf8, encoding: 'utf-8' };
  const layout = utf16Layout(bytes);
  if (layout) {
    const text = read(layout);
    if (text !== null && !controls.test(text)) return { text, encoding: layout };
  }
  if (utf8 !== null || bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0)) throw binary();
  const chinese = read('gb18030');
  if (chinese !== null && controls.test(chinese)) throw binary();
  if (chinese !== null && han.test(chinese)) return { text: chinese, encoding: 'gb18030' };
  throw invalid();
}

module.exports = { decodeText };
