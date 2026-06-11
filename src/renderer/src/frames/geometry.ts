import type { CanvasNode } from '@/canvas/nodes'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const nodeRect = (n: CanvasNode): Rect => ({
  x: n.position.x,
  y: n.position.y,
  w: n.width ?? 0,
  h: n.height ?? 0,
})

const centerInside = (rect: Rect, n: CanvasNode): boolean => {
  const cx = n.position.x + (n.width ?? 0) / 2
  const cy = n.position.y + (n.height ?? 0) / 2
  return cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h
}

/** Frame membership is geometric — which items sit (by center) inside its
 *  rect — so nothing is "trapped": drag one out and it simply leaves. */
export function frameMembers(frame: CanvasNode, nodes: CanvasNode[]): CanvasNode[] {
  const rect = nodeRect(frame)
  return nodes.filter((n) => n.type !== 'frame' && centerInside(rect, n))
}
