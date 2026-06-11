/// Pure unified-diff presentation: split a raw diff into typed lines with a
/// muted line-number gutter (port of the Swift DiffContentView.colorize).
/// Line numbers come from the `@@` hunk headers (new-side for adds/context,
/// old-side for deletions).

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx'

export interface DiffLine {
  gutter: string // 4-wide right-aligned line number, blank for headers
  text: string
  kind: DiffLineKind
}

export function diffLines(raw: string): DiffLine[] {
  const out: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  for (const s of raw.split('\n')) {
    let kind: DiffLineKind
    let n: number | null = null
    if (s.startsWith('@@')) {
      kind = 'hunk'
      const h = parseHunk(s)
      if (h) [oldNo, newNo] = h
    } else if (
      s.startsWith('+++') ||
      s.startsWith('---') ||
      s.startsWith('diff ') ||
      s.startsWith('index ') ||
      s.startsWith('new file') ||
      s.startsWith('deleted file') ||
      s.startsWith('rename ')
    ) {
      kind = 'meta'
    } else if (s.startsWith('+')) {
      kind = 'add'
      n = newNo
      newNo += 1
    } else if (s.startsWith('-')) {
      kind = 'del'
      n = oldNo
      oldNo += 1
    } else {
      kind = 'ctx'
      n = newNo
      newNo += 1
      oldNo += 1
    }
    out.push({ gutter: gutterCol(n), text: s, kind })
  }
  return out
}

/** A 4-wide right-aligned gutter cell (blank for header lines). */
function gutterCol(n: number | null): string {
  if (n === null) return '    '
  return String(n).padStart(4, ' ')
}

/** Parse `@@ -old,n +new,m @@` → [oldStart, newStart]. */
function parseHunk(s: string): [number, number] | null {
  let oldStart = 0
  let newStart = 0
  let foundOld = false
  let foundNew = false
  for (const part of s.split(' ')) {
    if (!foundOld && part.startsWith('-')) {
      oldStart = parseInt(part.slice(1), 10) || 0
      foundOld = true
    } else if (!foundNew && part.startsWith('+')) {
      newStart = parseInt(part.slice(1), 10) || 0
      foundNew = true
    }
    if (foundOld && foundNew) break
  }
  return foundOld || foundNew ? [oldStart, newStart] : null
}
