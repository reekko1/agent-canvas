// Shared MCP tool-result builders for the two browser MCP servers — the
// in-process canvas server (canvasServer.ts) and the per-card agent server
// (agentBrowserMcp.ts). Both surface results in the identical `{ content: [...] }`
// shape, so the ok/fail/error/image builders live here once instead of forking.

/** Flatten an unknown thrown value to a message string. */
export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** A success result carrying JSON-serialized data as text content. */
export const okResult = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data) }],
})

/** A failure result carrying a plain message. */
export const failResult = (message: string) => ({
  content: [{ type: 'text' as const, text: message }],
  isError: true,
})

/** Convert a screenshot data URL (built by browserController) into an MCP
 *  image-content block, or null if it isn't a base64 data URL. Shared by both
 *  servers' browser_screenshot tools. */
export function dataUrlToImageContent(image: string) {
  const m = /^data:(.+?);base64,(.*)$/.exec(image)
  if (!m) return null
  return { content: [{ type: 'image' as const, data: m[2], mimeType: m[1] }] }
}
