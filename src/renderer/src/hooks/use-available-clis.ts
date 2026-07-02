import { useEffect, useState } from 'react'
import type { CliKind } from '@shared/types'

/// The renderer's one source for which coding-agent CLIs are installed. The
/// real probe lives in main (`spine.availableClis()` — `command -v` per
/// registered driver over the login shell); this hook owns the client policy:
/// fetch on mount, re-probe whenever `refresh` changes (stale-while-revalidate
/// — pass a menu-open flag, an install-flow completion counter, …), and never
/// return empty (no CLI on PATH falls back to claude so a picker is never
/// blank). Missing CLIs, for an install affordance, are just
/// `CLI_KINDS.filter((k) => !installed.includes(k))`.
export function useAvailableClis(refresh?: unknown): CliKind[] {
  const [clis, setClis] = useState<CliKind[]>(['claude'])
  useEffect(() => {
    void window.canvas.availableClis().then((found) => setClis(found.length ? found : ['claude']))
  }, [refresh])
  return clis
}
