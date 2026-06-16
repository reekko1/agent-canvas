import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Last path segment of a folder — the card/canvas display name. `undefined`
 *  for an empty or root-only path, so callers keep their own fallback. */
export const basenameOf = (p: string): string | undefined =>
  p.split("/").filter(Boolean).pop()
