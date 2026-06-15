import { useEffect, useRef } from 'react'
import backdropDark from '@/assets/backdrop-dark.mp4'
import backdropLight from '@/assets/backdrop-light.mp4'

/// A full-bleed looping video backdrop behind the canvas. Unlike the old dot
/// grid it is **fixed to the window** — it doesn't pan or zoom with the
/// canvas; the cards glide over it like a studio wall. It carries
/// a dark- and a light-theme clip and swaps on theme change (the same <html>
/// class flip the terminals watch). Aspect-fill, muted, looped, and paused
/// whenever the window is hidden so it costs nothing off-screen.
/// (Port of the Swift VideoBackdropView.)
export function VideoBackdrop() {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current!

    // (Re)load the clip matching the current theme, but only when the variant
    // actually changes — avoids a needless reload + flash on every class ping.
    let isDark: boolean | undefined
    const loadVariantIfNeeded = () => {
      const dark = document.documentElement.classList.contains('dark')
      if (dark === isDark) return
      isDark = dark
      video.src = dark ? backdropDark : backdropLight
      void video.play().catch(() => {}) // autoplay races are benign — muted video
    }
    loadVariantIfNeeded()

    const themeObserver = new MutationObserver(loadVariantIfNeeded)
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })

    // Chromium marks the page hidden when the window is minimized or fully
    // occluded — the web end of AppKit's occlusion state.
    const onVisibility = () => {
      if (document.hidden) video.pause()
      else void video.play().catch(() => {})
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      themeObserver.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return (
    // bg-background under the video covers the gap before the first frame
    // decodes and any aspect-fill edge cases during resize.
    <div aria-hidden className="absolute inset-0 bg-background">
      <video
        ref={videoRef}
        autoPlay
        loop
        muted
        playsInline
        className="h-full w-full object-cover"
      />
      {/* A subtle black scrim so the cards read as a distinct
          layer above the footage (separation), and the video sits back. */}
      <div className="absolute inset-0 bg-black/28" />
    </div>
  )
}
