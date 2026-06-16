// Pure selection math for AskUserQuestions — no React, no refs, no DOM. The
// component owns the refs/state and passes their current values in, so this
// stays trivially testable.
import type { AskUserOption, AskUserQuestion } from "@/components/ui/ask-user-questions";

export function questionKey(q: AskUserQuestion, i: number) {
  return q.id ?? `q-${i}`;
}

export function optionKey(o: AskUserOption, i: number) {
  return o.id ?? `o-${i}`;
}

/** The row indices that are currently selected: option rows whose key is in
 *  `selectedIds`, plus the Other row (when present and holding text) so it
 *  merges into the same contiguous selected-bg block as adjacent options. */
export function computeSelectedIndices(
  options: AskUserOption[],
  selectedIds: string[],
  allowOther: boolean,
  otherText: string,
  otherIndex: number
): Set<number> {
  const set = new Set<number>();
  options.forEach((opt, i) => {
    if (selectedIds.includes(optionKey(opt, i))) set.add(i);
  });
  if (allowOther && otherText.length > 0) set.add(otherIndex);
  return set;
}

export interface SelectedGroup {
  start: number;
  end: number;
  id: number;
}

/** Collapse contiguous selected indices into runs with STABLE ids (so a
 *  growing/shrinking run animates instead of exit+re-enter when neighbours
 *  flip). Pure: takes the previous index→id map + the id counter and returns
 *  the groups plus the next map/counter for the caller to store back in its
 *  refs. Mirrors the CheckboxGroup pattern. */
export function computeSelectedGroups(
  selectedIndices: Set<number>,
  prevGroupMap: Map<number, number>,
  counter: number
): { groups: SelectedGroup[]; nextGroupMap: Map<number, number>; nextCounter: number } {
  const runs: { start: number; end: number }[] = [];
  const sorted = [...selectedIndices].sort((a, b) => a - b);
  for (const idx of sorted) {
    const last = runs[runs.length - 1];
    if (last && idx === last.end + 1) last.end = idx;
    else runs.push({ start: idx, end: idx });
  }

  // Stable run IDs so a growing/shrinking run animates instead of
  // exit+re-enter when neighbours flip.
  let nextCounter = counter;
  const usedIds = new Set<number>();
  const nextGroupMap = new Map<number, number>();
  const groups = runs.map((run) => {
    let stableId: number | null = null;
    for (let i = run.start; i <= run.end; i++) {
      const prev = prevGroupMap.get(i);
      if (prev !== undefined && !usedIds.has(prev)) {
        stableId = prev;
        break;
      }
    }
    const id = stableId ?? ++nextCounter;
    usedIds.add(id);
    for (let i = run.start; i <= run.end; i++) nextGroupMap.set(i, id);
    return { ...run, id };
  });
  return { groups, nextGroupMap, nextCounter };
}
