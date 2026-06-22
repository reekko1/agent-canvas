// Deterministic curator (no model): age unused skills. unused > staleDays -> stale,
// > archiveDays -> archived (recoverable). Reactivates if used since. Skills only.
// ponytail: pure function, no cadence/persistence — unwired today (the skill library is
// empty until the reviewer authors into it). The caller drives when to run it; wire a
// timer in index.ts once there's a library worth aging.
import { listSkills, skillActivity, archiveSkill } from './skills'

const DAY = 24 * 60 * 60 * 1000

export function ageSkills(
  now: number,
  { staleDays = 30, archiveDays = 90 }: { staleDays?: number; archiveDays?: number } = {},
): { archived: string[]; stale: string[] } {
  const archived: string[] = []
  const stale: string[] = []
  for (const { name } of listSkills()) {
    const idleDays = (now - skillActivity(name)) / DAY
    if (idleDays >= archiveDays) {
      archiveSkill(name)
      archived.push(name)
    } else if (idleDays >= staleDays) {
      stale.push(name)
    }
  }
  return { archived, stale }
}
