export type Locale = string;

export interface LocalizedContent<V> {
  subject: string | ((vars: V) => string);
  /** Plain text. `{{name}}` placeholders are substituted verbatim. */
  text: string;
  /** HTML. `{{name}}` placeholders are HTML-escaped; use `{{{name}}}` for trusted raw HTML. */
  html?: string;
}

export interface TemplateDefinition<V extends Record<string, string | number>> {
  id: string;
  defaultLocale: Locale;
  locales: Record<Locale, LocalizedContent<V>>;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html?: string;
  locale: Locale;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Identity helper that infers the variable type for you. */
export function defineTemplate<V extends Record<string, string | number>>(
  def: TemplateDefinition<V>,
): TemplateDefinition<V> {
  if (!def.locales[def.defaultLocale]) {
    throw new Error(`Template "${def.id}": default locale "${def.defaultLocale}" has no content`);
  }
  return def;
}

/** "es-MX" -> "es-MX", then "es", then the template default. */
export function resolveLocale(def: TemplateDefinition<never>, requested?: string): Locale {
  if (requested) {
    if (def.locales[requested]) return requested;
    const base = requested.split('-')[0]!.toLowerCase();
    if (def.locales[base]) return base;
  }
  return def.defaultLocale;
}

function fill(tpl: string, vars: Record<string, string | number>, escape: boolean, id: string): string {
  const sub = (name: string, raw: boolean): string => {
    if (!(name in vars)) throw new Error(`Template "${id}": missing variable "${name}"`);
    const value = String(vars[name]);
    return escape && !raw ? escapeHtml(value) : value;
  };
  return tpl
    .replace(/\{\{\{\s*(\w+)\s*\}\}\}/g, (_m, n: string) => sub(n, true))
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, n: string) => sub(n, false));
}

export function renderTemplate<V extends Record<string, string | number>>(
  def: TemplateDefinition<V>,
  vars: V,
  locale?: Locale,
): RenderedEmail {
  const resolved = resolveLocale(def as TemplateDefinition<never>, locale);
  const c = def.locales[resolved]!;
  const subject = typeof c.subject === 'function' ? c.subject(vars) : fill(c.subject, vars, false, def.id);
  return {
    subject,
    text: fill(c.text, vars, false, def.id),
    html: c.html === undefined ? undefined : fill(c.html, vars, true, def.id),
    locale: resolved,
  };
}
