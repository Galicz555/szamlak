/** Markup that is already safe. Only `html` and `raw` create one. */
export class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

type Value = Html | string | number | null | undefined | false | readonly Value[];

function render(v: Value): string {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return (v as readonly Value[]).map(render).join("");
  return escapeHtml(String(v));
}

/**
 * Auto-escaping template: every interpolation is escaped unless it is itself `Html`. Mail
 * subjects, PDF text and bank remittance all reach the page, so there is no unescaped path.
 */
export function html(strings: TemplateStringsArray, ...values: Value[]): Html {
  let out = strings[0] ?? "";
  values.forEach((v, i) => {
    out += render(v) + (strings[i + 1] ?? "");
  });
  return new Html(out);
}

/** For trusted constant markup only (never data). */
export function raw(markup: string): Html {
  return new Html(markup);
}
