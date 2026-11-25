const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { deflateSync, crc32 } = require('node:zlib');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'fixtures');
const ffmpeg = process.env.FFMPEG || 'ffmpeg';

function ff(args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: root, stdio: 'inherit' });
  if (result.status) throw new Error('FFmpeg failed: ' + result.status);
  if (result.error) throw result.error;
}
function pdf() {
  const text = [
    '0.10 0.22 0.16 rg 0 670 560 80 re f 1 1 1 rg BT /F1 24 Tf 42 700 Td (Study Drive / Lesson 01) Tj ET 0.10 0.22 0.16 rg BT /F1 14 Tf 42 632 Td (Reading a function graph) Tj 0 -32 Td (Compare the slope over consecutive intervals.) Tj ET 0.25 0.43 0.31 RG 3 w 75 310 m 75 550 l 480 310 m 75 310 l S 5 w 85 332 m 175 364 225 515 325 460 c 380 438 435 403 468 508 c S',
    '0.10 0.22 0.16 rg 0 670 560 80 re f 1 1 1 rg BT /F1 24 Tf 42 700 Td (Study Drive / Exercises) Tj ET 0.10 0.22 0.16 rg BT /F1 14 Tf 42 622 Td (1. Mark the local maximum on the graph.) Tj 0 -34 Td (2. Describe the intervals where the function increases.) Tj 0 -34 Td (3. Sketch a translation of the original graph.) Tj ET'
  ];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    ...[6, 7].map(n => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 560 750] /Contents ' + n + ' 0 R /Resources << /Font << /F1 5 0 R >> >> >>'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...text.map(value => '<< /Length ' + value.length + ' >>\nstream\n' + value + '\nendstream')
  ];
  let result = '%PDF-1.4\n';
  const offsets = objects.map((value, i) => {
    const offset = result.length;
    result += (i + 1) + ' 0 obj\n' + value + '\nendobj\n';
    return offset;
  });
  const xref = result.length;
  result += 'xref\n0 8\n0000000000 65535 f \n' + offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  result += 'trailer\n<< /Root 1 0 R /Size 8 >>\nstartxref\n' + xref + '\n%%EOF\n';
  fs.writeFileSync(path.join(dir, 'notes.pdf'), result);
}
function pngChunk(name, data) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length);
  header.write(name, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])));
  return Buffer.concat([header, data, tail]);
}
function brand() {
  const size = 256;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const corner = Math.hypot(Math.max(44 - x, x - 211, 0), Math.max(44 - y, y - 211, 0)) < 35;
      const edge = 73 + Math.abs(x - 128) * -.20;
      const page = x > 49 && x < 207 && y > edge && y < edge + 100;
      const spine = Math.abs(x - 128) < 4;
      const marks = [104, 125].some(line => Math.abs(y - (line - Math.abs(x - 128) * .17)) < 3.1);
      const inner = (x > 65 && x < 109) || (x > 147 && x < 191);
      const ink = corner ? [36, 76, 58, 255] : [0, 0, 0, 0];
      if (corner && page && !spine && !(inner && marks)) ink.splice(0, 4, 235, 242, 210, 255);
      raw.set(ink, y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6], 8);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(path.join(root, 'src', 'renderer', 'mark.png'), png);
  const ico = Buffer.alloc(22);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(1, 4);
  ico.writeUInt16LE(1, 10);
  ico.writeUInt16LE(32, 12);
  ico.writeUInt32LE(png.length, 14);
  ico.writeUInt32LE(22, 18);
  fs.writeFileSync(path.join(root, 'src', 'renderer', 'mark.ico'), Buffer.concat([ico, png]));
}

fs.mkdirSync(dir, { recursive: true });
brand();
pdf();
if (process.argv.includes('--documents-only')) process.exit();
console.log('Generating synthetic H.264/AAC lesson and preview fixtures');
ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=20:d=82', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:d=82',
  '-vf', 'drawgrid=width=64:height=45:thickness=1:color=white@0.25', '-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'baseline', '-pix_fmt',
  'yuv420p', '-b:v', '620k', '-maxrate', '700k', '-bufsize', '620k', '-g', '40', '-c:a', 'aac', '-b:a', '80k', '-af', 'volume=0.08', '-movflags', '+faststart', 'fixtures/lesson.mp4']);
ff(['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100:d=15', '-af', 'volume=0.08', '-c:a', 'aac', 'fixtures/review.m4a']);
ff(['-ss', '1', '-i', 'fixtures/lesson.mp4', '-frames:v', '1', '-update', '1', 'fixtures/diagram.png']);
