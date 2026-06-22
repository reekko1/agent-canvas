// Model split (from the design): the reactor reasons (Opus, matching the
// orchestrator), the reviewers distill (Sonnet — cheaper, sufficient). The probe
// shared one model; the lift splits them per call.
export const REACTOR_MODEL = 'claude-opus-4-8'
export const REVIEWER_MODEL = 'claude-sonnet-4-6'

/** Force the subscription auth path — a stray ANTHROPIC_API_KEY would outrank the
 *  CLAUDE_CODE_OAUTH_TOKEN / host `claude login` creds and silently bill PAYG. The
 *  orchestrator already does this at startup (orchestrator.ts); the reactor +
 *  reviewers share that process env, so this is a belt-and-braces no-op there and the
 *  guard for any standalone run. */
export function ensureSubscriptionAuth(): void {
  delete process.env.ANTHROPIC_API_KEY
}
