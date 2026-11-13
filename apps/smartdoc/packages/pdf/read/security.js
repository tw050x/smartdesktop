// PDF's standard security handler (PDF 32000-1 7.6.3, ISO 32000-2 7.6.4): working out the file's
// key from a password (most often the empty one, for files only restricted against printing or
// copying), and decrypting strings and streams with RC4, AES-128 or AES-256.

import { aesDecrypt, aesEncrypt, md5, rc4, sha256, sha384, sha512 } from './hash.js';
import { Name } from './objects.js';
import { bytesOf } from './parser.js';

const PAD = Uint8Array.from([0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a]);

export class PasswordError extends Error {
  constructor() {
    super('The document needs a password to open.');
    this.name = 'PasswordError';
  }
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const equal = (a, b, n = Math.min(a.length, b.length)) => {
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return a.length >= n && b.length >= n;
};

// `encrypt` is the trailer's /Encrypt dictionary, `id` the first element of its /ID (a binary
// string). Throws PasswordError if `password` (a string) opens it as neither user nor owner.
export function createSecurity(encrypt, id, password = '') {
  const filter = encrypt.name('Filter');
  if (filter && filter !== 'Standard') throw new Error(`The document is protected by ${filter}, which can't be opened.`);
  const V = encrypt.number('V', 0);
  const R = encrypt.number('R', 2);
  const O = bytesOf(encrypt.get('O') ?? '');
  const U = bytesOf(encrypt.get('U') ?? '');
  const P = encrypt.number('P', 0);
  const fileId = bytesOf(id ?? '');
  const encryptMetadata = encrypt.get('EncryptMetadata') !== false;

  // How strings and streams are encrypted: 'rc4', 'aes128', 'aes256' or 'none' (Identity).
  let stmMethod = 'rc4';
  let strMethod = 'rc4';
  let length = encrypt.number('Length', 40) / 8;
  if (V >= 4) {
    const cf = encrypt.dict('CF');
    const method = (filterName) => {
      if (!filterName || filterName === 'Identity') return 'none';
      const f = cf?.dict(filterName);
      const cfm = f?.name('CFM');
      if (f?.number('Length')) length = f.number('Length') > 32 ? f.number('Length') / 8 : f.number('Length');
      return methodOf(cfm);
    };
    stmMethod = method(encrypt.name('StmF'));
    strMethod = method(encrypt.name('StrF'));
  }
  if (V === 1) length = 5;
  // A crypt filter's method by its name, as a stream's own Crypt filter names it.
  const named = (filterName) => {
    if (!filterName || filterName === 'Identity') return 'none';
    const cfm = encrypt.dict('CF')?.dict(filterName)?.name('CFM');
    return R >= 5 && cfm && cfm !== 'None' ? 'aes256' : methodOf(cfm);
  };

  // Only attachments encrypted (StmF and StrF Identity, an EFF of their own): the document itself
  // opens without a password.
  if (stmMethod === 'none' && strMethod === 'none') return { decryptString: (s) => s, decryptStream: (data) => data, decryptStreamWith: (name, data) => data };

  let key;
  if (R >= 5) key = keyR6(encrypt, password, R, O, U);
  else key = keyR4(password, { R, O, U, P, fileId, length, encryptMetadata });
  if (!key) throw new PasswordError();
  // A V4 key shorter than 128 bits is padded with zeros to 16 bytes before use (Acrobat does
  // this, and pdf.js after it; the spec doesn't say).
  if (V === 4 && key.length < 16) {
    const padded = new Uint8Array(16);
    padded.set(key);
    key = padded;
  }

  const objectKey = (ref, aes) => {
    if (R >= 5) return key;
    const extra = Uint8Array.of(ref.num & 0xff, (ref.num >> 8) & 0xff, (ref.num >> 16) & 0xff, ref.gen & 0xff, (ref.gen >> 8) & 0xff);
    const salt = aes ? Uint8Array.of(0x73, 0x41, 0x6c, 0x54) : new Uint8Array(0);
    return md5(concat(key, extra, salt)).subarray(0, Math.min(key.length + 5, 16));
  };
  const run = (method, data, ref) => {
    if (method === 'none') return data;
    if (method === 'rc4') return rc4(objectKey(ref, false), data);
    if (data.length < 16) return new Uint8Array(0);
    return aesDecrypt(objectKey(ref, true), data);
  };
  return {
    decryptString: (s, ref) => latin(run(strMethod, bytesOf(s), ref)),
    decryptStream: (data, ref, stream) => {
      // An XRef stream isn't encrypted, nor metadata when EncryptMetadata is false.
      const type = stream?.dict.get('Type');
      if (type instanceof Name && (type.name === 'XRef' || (type.name === 'Metadata' && !encryptMetadata))) return data;
      return run(stmMethod, data, ref);
    },
    // A stream with Crypt filters of its own is decrypted by them, not as other streams are.
    decryptStreamWith: (filterName, data, ref) => run(named(filterName), data, ref),
  };
}

// A crypt filter's CFM as a method; none given, or None, is no encryption (as pdf.js reads it).
const methodOf = (cfm) => (!cfm || cfm === 'None' ? 'none' : cfm === 'AESV2' ? 'aes128' : cfm === 'AESV3' ? 'aes256' : 'rc4');

const latin = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return s;
};

// Revisions 2 to 4: the key from the user password (algorithm 2), checked against /U (4, 5); if
// it fails, the password is tried as the owner's (7), which gives the user password.
function keyR4(password, opts) {
  const pw = passwordBytes(password);
  const tryUser = (userPw) => {
    const key = computeKey(userPw, opts);
    return checkUser(key, opts) ? key : null;
  };
  let key = tryUser(pw);
  if (key) return key;
  // As the owner's password: RC4 /O with a key from it, giving the user's password.
  let h = md5(pad(pw));
  if (opts.R >= 3) for (let i = 0; i < 50; i++) h = md5(h);
  const ownerKey = h.subarray(0, opts.R >= 3 ? opts.length : 5);
  let userPw = opts.O.subarray(0, 32);
  if (opts.R === 2) userPw = rc4(ownerKey, userPw);
  else for (let i = 19; i >= 0; i--) userPw = rc4(ownerKey.map((b) => b ^ i), userPw);
  key = tryUser(userPw);
  return key;
}

function passwordBytes(password) {
  // Latin-1 (PDFDocEncoding, nearly) for revisions up to 4.
  return Uint8Array.from([...password].slice(0, 32), (c) => c.charCodeAt(0) & 0xff);
}

function pad(pw) {
  const out = new Uint8Array(32);
  out.set(pw.subarray(0, 32));
  out.set(PAD.subarray(0, 32 - Math.min(32, pw.length)), Math.min(32, pw.length));
  return out;
}

function computeKey(pw, { R, O, P, fileId, length, encryptMetadata }) {
  const p = Uint8Array.of(P & 0xff, (P >> 8) & 0xff, (P >> 16) & 0xff, (P >>> 24) & 0xff);
  let h = md5(concat(pad(pw), O.subarray(0, 32), p, fileId, R >= 4 && !encryptMetadata ? Uint8Array.of(255, 255, 255, 255) : new Uint8Array(0)));
  const n = R >= 3 ? length : 5;
  if (R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
  return h.subarray(0, n);
}

function checkUser(key, { R, U, fileId }) {
  if (R === 2) return equal(rc4(key, PAD), U, 32);
  let h = md5(concat(PAD, fileId));
  h = rc4(key, h);
  for (let i = 1; i <= 19; i++) h = rc4(key.map((b) => b ^ i), h);
  return equal(h, U, 16);
}

// Revisions 5 and 6 (AES-256): the password, as UTF-8 (SASLprep is left out), checked against
// /U and then /O, the file key decrypted from /UE or /OE.
function keyR6(encrypt, password, R, O, U) {
  const pw = new TextEncoder().encode(password).subarray(0, 127);
  const UE = bytesOf(encrypt.get('UE') ?? '');
  const OE = bytesOf(encrypt.get('OE') ?? '');
  const hash = (pwd, salt, udata) => (R === 5 ? sha256(concat(pwd, salt, udata)) : hardenedHash(pwd, salt, udata));
  const empty = new Uint8Array(0);
  // As the user.
  if (equal(hash(pw, U.subarray(32, 40), empty), U, 32)) {
    const k = hash(pw, U.subarray(40, 48), empty);
    return aesDecrypt(k, UE.subarray(0, 32), new Uint8Array(16), false);
  }
  // As the owner.
  const u48 = U.subarray(0, 48);
  if (equal(hash(pw, O.subarray(32, 40), u48), O, 32)) {
    const k = hash(pw, O.subarray(40, 48), u48);
    return aesDecrypt(k, OE.subarray(0, 32), new Uint8Array(16), false);
  }
  return null;
}

// ISO 32000-2 algorithm 2.B.
function hardenedHash(pw, salt, udata) {
  let K = sha256(concat(pw, salt, udata));
  for (let round = 0; ; round++) {
    const one = concat(pw, K, udata);
    const K1 = new Uint8Array(one.length * 64);
    for (let i = 0; i < 64; i++) K1.set(one, i * one.length);
    const E = aesEncrypt(K.subarray(0, 16), K1, K.subarray(16, 32));
    let sum = 0;
    for (let i = 0; i < 16; i++) sum += E[i];
    const which = sum % 3;
    K = which === 0 ? sha256(E) : which === 1 ? sha384(E) : sha512(E);
    if (round >= 63 && E[E.length - 1] <= round - 32) break;
  }
  return K.subarray(0, 32);
}
