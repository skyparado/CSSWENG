import { PDFDocument } from '@cantoo/pdf-lib';
import { badRequest } from '../http.js';

const invalid = () => badRequest('File contents do not match a supported image or PDF');

// Strip free-text, location and camera metadata without recompressing the
// clinical pixels. Keep color profiles, and retain only orientation from EXIF.
function orientation(segment: Buffer): Buffer | undefined {
  if (!segment.subarray(0, 6).equals(Buffer.from('Exif\0\0'))) return;
  const tiff = segment.subarray(6);
  if (tiff.length < 8) return;
  const le = tiff.toString('ascii', 0, 2) === 'II';
  const u16 = (n: number) => le ? tiff.readUInt16LE(n) : tiff.readUInt16BE(n);
  const ifd = le ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4);
  if (ifd + 2 > tiff.length) return;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const pos = ifd + 2 + 12 * i;
    if (pos + 12 > tiff.length) return;
    if (u16(pos) !== 0x112 || u16(pos + 2) !== 3) continue;
    const value = u16(pos + 8);
    if (value < 1 || value > 8) return;
    const entry = Buffer.from('ffe100224578696600004d4d002a00000008000101120003000000010001000000000000', 'hex');
    entry.writeUInt16BE(value, 28);
    return entry;
  }
}

function jpeg(file: Buffer) {
  if (file.length < 4 || file.readUInt16BE(0) !== 0xffd8) throw invalid();
  const parts = [file.subarray(0, 2)];
  for (let pos = 2; pos + 4 <= file.length;) {
    if (file[pos] !== 0xff) throw invalid();
    const marker = file[pos + 1];
    if (marker === 0xda) { parts.push(file.subarray(pos)); return Buffer.concat(parts); }
    const size = file.readUInt16BE(pos + 2);
    const end = pos + 2 + size;
    if (size < 2 || end > file.length) throw invalid();
    if (marker === 0xe1) {
      const retained = orientation(file.subarray(pos + 4, end));
      if (retained) parts.push(retained);
    } else if (marker !== 0xed && marker !== 0xfe) parts.push(file.subarray(pos, end));
    pos = end;
  }
  throw invalid();
}

function png(file: Buffer) {
  if (!file.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw invalid();
  const parts = [file.subarray(0, 8)];
  let hasPixels = false;
  for (let pos = 8; pos + 12 <= file.length;) {
    const end = pos + 12 + file.readUInt32BE(pos);
    if (end > file.length) throw invalid();
    const type = file.toString('ascii', pos + 4, pos + 8);
    if (pos === 8 && type !== 'IHDR') throw invalid();
    if (type === 'IDAT') hasPixels = true;
    if (!['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'].includes(type)) parts.push(file.subarray(pos, end));
    if (type === 'IEND' && hasPixels) return Buffer.concat(parts);
    pos = end;
  }
  throw invalid();
}

export async function prepareUpload(file: Buffer, mime: string) {
  if (mime === 'image/jpeg') return jpeg(file);
  if (mime === 'image/png') return png(file);
  if (mime !== 'application/pdf' || file.toString('ascii', 0, 5) !== '%PDF-') throw invalid();
  try {
    // Preserve referrals, including their signatures and clinically relevant provenance.
    await PDFDocument.load(file, { updateMetadata: false, ignoreEncryption: true });
    return file;
  } catch { throw invalid(); }
}
