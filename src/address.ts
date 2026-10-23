const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;

export function normalizeEmail(address: string): string {
  return address.trim().toLowerCase();
}

export function isValidEmail(address: string): boolean {
  const a = address.trim();
  return a.length <= 254 && EMAIL_RE.test(a) && !a.includes('..');
}

/** One address with an optional display name, e.g. `Ana García <ana@example.com>`. */
export interface Mailbox {
  address: string;
  name?: string;
}

/** `"Doe, Jane" <j@example.com>` or `j@example.com` → `{ name, address }`. The address is lower-cased. */
export function parseMailbox(input: string): Mailbox | undefined {
  const s = input.trim();
  if (!s) return undefined;
  const angled = /^(.*?)\s*<([^<>]+)>\s*$/.exec(s);
  if (angled) {
    const name = angled[1]!.trim().replace(/^"(.*)"$/, '$1').replace(/\\(["\\])/g, '$1');
    const address = normalizeEmail(angled[2]!);
    return name ? { name, address } : { address };
  }
  const bare = s.replace(/^<|>$/g, '');
  return bare.includes('@') ? { address: normalizeEmail(bare) } : undefined;
}

/** Splits a header-style list on commas that are outside quotes and angle brackets. */
export function parseMailboxList(input: string | string[] | undefined): Mailbox[] {
  if (!input) return [];
  const parts: string[] = [];
  for (const chunk of Array.isArray(input) ? input : [input]) {
    let current = '';
    let quoted = false;
    let depth = 0;
    for (const ch of chunk) {
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === '<') depth++;
      else if (!quoted && ch === '>') depth = Math.max(0, depth - 1);
      if (ch === ',' && !quoted && depth === 0) {
        parts.push(current);
        current = '';
      } else current += ch;
    }
    parts.push(current);
  }
  return parts.map(parseMailbox).filter((m): m is Mailbox => m !== undefined);
}

export function formatMailbox(m: Mailbox): string {
  if (!m.name) return m.address;
  const safe = /^[\p{L}\p{N}_ .'-]+$/u.test(m.name) ? m.name : `"${m.name.replace(/(["\\])/g, '\\$1')}"`;
  return `${safe} <${m.address}>`;
}
