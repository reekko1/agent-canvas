// The two reviewers: each a separate query() returning a validated plan via
// outputFormat. They read the in-scope reaction transcripts via getSessionMessages
// (raw transcripts — no separate record format), plus current memory + skills.
// persistSession:false so reviewer chatter doesn't clutter the session store. Model =
// Sonnet (the reactor is Opus). The memory reviewer takes a projectId — product memory
// is per-canvas.
import { query, getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import { REVIEWER_MODEL } from './models'
import { reactorCwd } from './paths'
import { snapshot, remaining, BUDGET, type MemWrite } from './memory'
import { listSkills, skillBody, type SkillAction } from './skills'
import { SKILL_CONSTITUTION, MEMORY_CONSTITUTION } from './constitutions'

export interface SkillPlan {
  nothing_to_save: boolean
  skill_actions: SkillAction[]
}
export interface MemoryPlan {
  nothing_to_save: boolean
  memory_writes: MemWrite[]
}

/** The shape of a persisted session message we render — a structural subset of what
 *  getSessionMessages returns (content is text | block array). */
interface RenderableMsg {
  type?: string
  message?: { content?: unknown }
}
interface TextBlock {
  type?: string
  text?: string
  name?: string
  input?: unknown
  content?: unknown
}

function renderMsg(m: RenderableMsg): string {
  const content = m?.message?.content
  let txt = ''
  if (typeof content === 'string') txt = content
  else if (Array.isArray(content))
    txt = (content as TextBlock[])
      .map((b) =>
        b?.type === 'text'
          ? b.text ?? ''
          : b?.type === 'tool_use'
            ? `[tool ${b.name} ${JSON.stringify(b.input)}]`
            : b?.type === 'tool_result'
              ? `[tool_result ${typeof b.content === 'string' ? b.content : JSON.stringify(b.content)}]`
              : '',
      )
      .filter(Boolean)
      .join(' ')
  return txt ? `${String(m.type).toUpperCase()}: ${txt}` : ''
}

async function transcriptOf(sessionIds: string[]): Promise<string> {
  const parts: string[] = []
  for (const id of sessionIds) {
    try {
      const msgs = (await getSessionMessages(id, { dir: reactorCwd() })) as RenderableMsg[]
      for (const m of msgs) {
        const r = renderMsg(m)
        if (r) parts.push(r)
      }
    } catch (e) {
      parts.push(`[could not read session ${id}: ${e}]`)
    }
  }
  return parts.join('\n') || '(no transcript)'
}

async function runReviewer<T>(
  systemPrompt: string,
  input: string,
  schema: Record<string, unknown>,
): Promise<T | null> {
  const q = query({
    prompt: input,
    options: {
      model: REVIEWER_MODEL,
      systemPrompt,
      outputFormat: { type: 'json_schema', schema },
      tools: [],
      settingSources: [],
      persistSession: false,
    },
  })
  for await (const m of q) {
    if (m.type === 'result') {
      if (m.subtype === 'success') {
        const out = (m as { structured_output?: unknown }).structured_output
        return (out ?? null) as T | null
      }
      return null // error_max_structured_output_retries etc -> treat as nothing-to-save
    }
  }
  return null
}

const SKILL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['nothing_to_save', 'skill_actions'],
  properties: {
    nothing_to_save: { type: 'boolean' },
    skill_actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['op', 'name', 'description', 'body'],
        properties: {
          op: { type: 'string', enum: ['create', 'patch'] },
          name: { type: 'string' },
          description: { type: 'string' },
          body: { type: 'string' },
        },
      },
    },
  },
}

const MEMORY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['nothing_to_save', 'memory_writes'],
  properties: {
    nothing_to_save: { type: 'boolean' },
    memory_writes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['store', 'op', 'text'],
        properties: {
          store: { type: 'string', enum: ['operator', 'product'] },
          op: { type: 'string', enum: ['add', 'replace', 'remove'] },
          target: { type: 'string' },
          text: { type: 'string' },
        },
      },
    },
  },
}

// Core skill review over a raw transcript — used for BOTH reaction episodes and the
// operator's direct conversation (the agent learning a procedure Rakan taught or implied).
// `kind` only labels the transcript; the reaction path keeps its original label byte-for-byte.
export async function reviewSkills(
  transcript: string,
  kind = 'EPISODE REACTIONS',
): Promise<SkillPlan | null> {
  const skills = listSkills()
  const index = skills.map((s) => `- ${s.name}: ${s.description}`).join('\n') || '(none)'
  const bodies = skills.map((s) => `### ${s.name}\n${skillBody(s.name)}`).join('\n\n') || '(none)'
  const input = `${kind} (transcript):\n${transcript}\n\nEXISTING SKILLS (index):\n${index}\n\nEXISTING SKILL BODIES:\n${bodies}`
  return runReviewer<SkillPlan>(SKILL_CONSTITUTION, input, SKILL_SCHEMA)
}

export async function runSkillReviewer(episodeSessionIds: string[]): Promise<SkillPlan | null> {
  return reviewSkills(await transcriptOf(episodeSessionIds))
}

// Core memory review over a raw transcript — used for BOTH fleet-reaction windows and
// the operator's direct conversation with the orchestrator. projectId is optional: with
// no active canvas, only operator (global) facts can be written.
export async function reviewMemory(
  transcript: string,
  projectId?: string,
  recurrenceDigest = '',
): Promise<MemoryPlan | null> {
  const productLine = projectId
    ? `CURRENT MEMORY — PRODUCT (budget ${BUDGET.product}, ${remaining('product', projectId)} left):\n${snapshot('product', projectId) || '(empty)'}`
    : 'CURRENT MEMORY — PRODUCT: (no active canvas — operator facts only)'
  const input =
    `TRANSCRIPT:\n${transcript}\n\n` +
    `RECURRENCE:\n${recurrenceDigest || '(none)'}\n\n` +
    `CURRENT MEMORY — OPERATOR (budget ${BUDGET.operator}, ${remaining('operator')} left):\n${snapshot('operator') || '(empty)'}\n\n` +
    productLine
  return runReviewer<MemoryPlan>(MEMORY_CONSTITUTION, input, MEMORY_SCHEMA)
}

export async function runMemoryReviewer(
  windowSessionIds: string[],
  projectId: string,
  recurrenceDigest = '',
): Promise<MemoryPlan | null> {
  return reviewMemory(await transcriptOf(windowSessionIds), projectId, recurrenceDigest)
}
