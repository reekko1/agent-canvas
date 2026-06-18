import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Last path segment of a folder — the card/canvas display name. `undefined`
 *  for an empty or root-only path, so callers keep their own fallback. */
export const basenameOf = (p: string): string | undefined =>
  p.split("/").filter(Boolean).pop()

/** Host of a browser card's url (e.g. "mail.google.com") — its display label.
 *  Falls back to the url itself when there's no host (file:/about:/data:) or it
 *  can't be parsed; `undefined` only when there's no url, so callers supply their
 *  own empty-state fallback. */
export const hostOf = (url?: string): string | undefined => {
  if (!url) return undefined
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}
