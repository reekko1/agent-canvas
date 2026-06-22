// A skill/memory `source` audit string. Two of its forms carry the canvas the
// lesson was learned on (`episode:<projectId>:<kind>`, `window:<projectId>`); the
// rest (e.g. `conversation`) don't. Built in main (mastermind/learning.ts), parsed
// in the renderer (SkillsPanel) — defined here so the format can't drift between them.
export const episodeSource = (projectId: string, kind: string): string =>
  `episode:${projectId}:${kind}`
export const windowSource = (projectId: string): string => `window:${projectId}`

/** The canvas id a `source` was learned on, or null for the canvas-less forms. */
export const provenanceCanvas = (source: string): string | null =>
  source.match(/^(?:episode|window):([^:]+)/)?.[1] ?? null
