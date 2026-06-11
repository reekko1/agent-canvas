/** Resolve a CSS custom property to its concrete value. xterm renders to
 *  canvas, so it needs resolved colors, not var() references. */
export const cssVar = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/** The terminal palette, resolved from the theme tokens in index.css.
 *  Re-read whenever dark/light flips (the tokens are hex for xterm's sake). */
export const terminalTheme = () => ({
  background: cssVar('--terminal-background'),
  foreground: cssVar('--terminal-foreground'),
  cursor: cssVar('--terminal-cursor'),
  selectionBackground: cssVar('--terminal-selection'),
})
