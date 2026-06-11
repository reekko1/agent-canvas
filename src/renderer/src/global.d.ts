import type { CanvasApi } from '../../shared/types'

declare global {
  interface Window {
    canvas: CanvasApi
  }
}

export {}
