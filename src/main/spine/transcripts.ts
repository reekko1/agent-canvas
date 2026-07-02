import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { TranscriptItem } from '../../shared/types'

/** How many trailing lines `load` reads back — enough for a card's recent
 *  history without loading an unbounded file into memory on every mount. */
const TAIL_ITEMS = 500

/// Append-only JSONL persistence for an agent card's transcript —
/// `SPINE_DIR/transcripts/<cardId>.jsonl`, one finalized TranscriptItem per
/// line. Streaming deltas are NOT persisted (only the closing, non-streaming
/// item is written), so the file is a clean replay of what a human would
/// have seen land. Survives app restarts (unlike the live session); `load`
/// is the initial paint before the live `transcript-item` push takes over —
/// the renderer applies last-wins-by-id so any overlap is harmless.
export class TranscriptStore {
  private readonly dir: string

  constructor(spineDir: string) {
    this.dir = join(spineDir, 'transcripts')
  }

  private path(cardId: string): string {
    return join(this.dir, `${cardId}.jsonl`)
  }

  /** Append one finalized item. Never called with `streaming: true` — the
   *  spine only persists an assistant item once its text is final. */
  append(cardId: string, item: TranscriptItem): void {
    mkdirSync(this.dir, { recursive: true })
    appendFileSync(this.path(cardId), JSON.stringify(item) + '\n')
  }

  /** The card's persisted transcript, oldest first, tailed to the last
   *  `TAIL_ITEMS` lines. Empty for a card with no history yet. Tolerant of a
   *  truncated last line (a crash mid-append) — it's simply dropped. */
  load(cardId: string): TranscriptItem[] {
    const file = this.path(cardId)
    if (!existsSync(file)) return []
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    const tail = lines.slice(-TAIL_ITEMS)
    const items: TranscriptItem[] = []
    for (const line of tail) {
      try {
        items.push(JSON.parse(line))
      } catch {
        // truncated/corrupt line (e.g. a crash mid-write) — skip it
      }
    }
    return items
  }

  /** Drop a card's transcript entirely — the ✕ path. */
  delete(cardId: string): void {
    try {
      unlinkSync(this.path(cardId))
    } catch {
      // already gone
    }
  }
}
