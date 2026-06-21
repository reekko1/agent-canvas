/// Tiny shared DOM helpers for the phone app (vanilla, no framework).

export const $ = (id: string): HTMLElement => document.getElementById(id)!

/** Escape untrusted text before interpolating into innerHTML. Always run this on
 *  any server/agent-supplied string — the panel renders by string concatenation. */
export function esc(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
