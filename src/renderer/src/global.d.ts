import type { CanvasApi } from '@shared/types'

declare global {
  interface Window {
    canvas: CanvasApi
  }
}

declare module 'react' {
  interface CSSProperties {
    /** Electron drag region. With `titleBarStyle: hiddenInset` the window is
     *  moved by marking strips draggable; the toolbars opt out via 'no-drag'. */
    WebkitAppRegion?: 'drag' | 'no-drag'
  }
}

export {}
