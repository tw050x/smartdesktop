// Values sent over a guest tab's connection (guests.js, tabs.js) are JSON, which has no bytes: a PDF
// or a font as a Uint8Array would arrive as an object of numbered keys, which nothing can read (a
// SmartDoc draft shown in SmartDesktop's window had no pages). So bytes go as { $bytes: base64 } and
// come back as bytes (a Buffer, which Electron hands a page as a Uint8Array), anywhere in a value.
const KEY = '$bytes';

export function encode(value) {
  if (value instanceof ArrayBuffer) return { [KEY]: Buffer.from(value).toString('base64') };
  if (ArrayBuffer.isView(value)) return { [KEY]: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object' && value.constructor === Object) {
    const out = {};
    for (const [key, one] of Object.entries(value)) out[key] = encode(one);
    return out;
  }
  return value;
}

export function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') {
    if (typeof value[KEY] === 'string' && Object.keys(value).length === 1) return Buffer.from(value[KEY], 'base64');
    const out = {};
    for (const [key, one] of Object.entries(value)) out[key] = decode(one);
    return out;
  }
  return value;
}
