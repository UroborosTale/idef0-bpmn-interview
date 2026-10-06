import crypto from "node:crypto";

/** Хэш пароля: scrypt$<соль>$<хэш>, обе части в base64. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${crypto.scryptSync(password, salt, 32).toString("base64")}`;
}

/** Сверка пароля с хэшем scrypt или (для разработки) с паролем в открытом виде — за постоянное время. */
export function verifyPassword(password: string, stored: string): boolean {
  if (stored.startsWith("scrypt$")) {
    const [, salt, hash] = stored.split("$");
    if (!salt || !hash) return false;
    const expected = Buffer.from(hash, "base64");
    const actual = crypto.scryptSync(password, Buffer.from(salt, "base64"), expected.length);
    return crypto.timingSafeEqual(actual, expected);
  }
  const a = Buffer.from(password);
  const b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
