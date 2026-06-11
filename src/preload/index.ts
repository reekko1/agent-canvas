import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AskDecision, CanvasApi } from '../shared/types'

function subscribe(channel: string, cb: (...args: any[]) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: any[]): void => cb(...args)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

const api: CanvasApi = {
  newCard: () => ipcRenderer.invoke('new-card'),
  killCard: (cardId) => ipcRenderer.invoke('kill-card', cardId),
  write: (cardId, data) => ipcRenderer.send('pty-write', cardId, data),
  resize: (cardId, cols, rows) => ipcRenderer.send('pty-resize', cardId, cols, rows),
  decide: (askId, decision: AskDecision) => ipcRenderer.send('decide-ask', askId, decision),
  releaseAsks: (cardId) => ipcRenderer.send('release-asks', cardId),
  onPtyData: (cb) => subscribe('pty-data', cb),
  onPtyExit: (cb) => subscribe('pty-exit', cb),
  onCardEvent: (cb) => subscribe('card-event', cb),
  onAsk: (cb) => subscribe('permission-ask', cb),
}

contextBridge.exposeInMainWorld('canvas', api)
