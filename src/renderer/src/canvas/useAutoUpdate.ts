import { useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/types'

/// The app's own self-update state, mirrored from electron-updater in main.
/// Events merge so the version captured at `update-available` survives the
/// version-less `download-progress` ticks. Only ever fires in packaged builds.
export function useAutoUpdate(): {
  update: UpdateStatus | null
  dismiss: () => void
  restart: () => void
} {
  const [update, setUpdate] = useState<UpdateStatus | null>(null)

  useEffect(
    () => window.canvas.onUpdateStatus((s) => setUpdate((prev) => ({ ...prev, ...s }))),
    [],
  )

  return {
    update,
    dismiss: () => setUpdate(null),
    restart: () => window.canvas.quitAndInstall(),
  }
}
