// Shared by the renderer and the bundled mobile panel — both alias @shared, so
// the relative-time rule lives in exactly one place across the build split.

/** Relative-time thresholds, in seconds. */
export const MINUTE = 60
export const HOUR = 3600
export const DAY = 86400

/** "now" / "5m" / "2h", then `overflow(seconds)` past a day (default "Nd"). `t`
 *  is epoch seconds; the panel passes raw seconds, the desktop passes ms/1000. */
export function relativeFromSeconds(
  t: number,
  opts?: { overflow?: (seconds: number) => string },
): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - t))
  if (s < MINUTE) return 'now'
  if (s < HOUR) return `${Math.floor(s / MINUTE)}m`
  if (s < DAY) return `${Math.floor(s / HOUR)}h`
  return opts?.overflow ? opts.overflow(s) : `${Math.floor(s / DAY)}d`
}
