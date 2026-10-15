const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;

export function normalizeEmail(address: string): string {
  return address.trim().toLowerCase();
}

export function isValidEmail(address: string): boolean {
  const a = address.trim();
  return a.length <= 254 && EMAIL_RE.test(a) && !a.includes('..');
}
