const PASSWORD_SCHEME = "pbkdf2-sha256";
export const PASSWORD_HASH_ITERATIONS = 310_000;

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomBytes(length) {
  const value = new Uint8Array(length);
  crypto.getRandomValues(value);
  return value;
}

async function derivePassword(password, salt, iterations) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    256,
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export async function hashPassword(password, iterations = PASSWORD_HASH_ITERATIONS) {
  const salt = randomBytes(16);
  const derived = await derivePassword(password, salt, iterations);
  return `${PASSWORD_SCHEME}$${iterations}$${bytesToBase64Url(salt)}$${bytesToBase64Url(derived)}`;
}

export async function verifyPassword(password, encoded) {
  const [scheme, iterationsText, saltText, hashText, extra] = String(encoded).split("$");
  const iterations = Number(iterationsText);
  if (scheme !== PASSWORD_SCHEME || extra !== undefined || !Number.isInteger(iterations) || iterations < 100_000 || iterations > 2_000_000) return false;
  try {
    const salt = base64UrlToBytes(saltText);
    const expected = base64UrlToBytes(hashText);
    const actual = await derivePassword(password, salt, iterations);
    return constantTimeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function generateOpaqueToken(byteLength = 32) {
  return bytesToBase64Url(randomBytes(byteLength));
}

export function generateRecoveryCode() {
  const compact = Array.from(randomBytes(16), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  return compact.match(/.{1,4}/gu).join("-");
}

export function normalizeRecoveryCode(value) {
  return String(value).replace(/[^a-fA-F0-9]/gu, "").toUpperCase();
}

export async function digestToken(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return bytesToBase64Url(new Uint8Array(digest));
}

export function normalizeEmail(value) {
  return String(value).trim().toLowerCase();
}
