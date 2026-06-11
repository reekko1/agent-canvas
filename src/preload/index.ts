import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AskDecision, CanvasApi } from '../shared/types'

function subscribe(channel: string, cb: (...args: any[]) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: any[]): void => cb(...args)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

const api: CanvasApi = {
  newCard: () => ipcRenderer.invoke('new-card'),
  newShell: () => ipcRenderer.invoke('new-shell'),
  ensureCard: (cardId, folder, cols, rows, kind) =>
    ipcRenderer.invoke('ensure-card', cardId, folder, cols, rows, kind),
  killCard: (cardId) => ipcRenderer.invoke('kill-card', cardId),
  readTodos: (sessionId) => ipcRenderer.invoke('read-todos', sessionId),
  newDiff: () => ipcRenderer.invoke('new-diff'),
  watchDiff: (diffId, folder) => ipcRenderer.invoke('watch-diff', diffId, folder),
  unwatchDiff: (diffId) => ipcRenderer.send('unwatch-diff', diffId),
  readFileDiff: (folder, change) => ipcRenderer.invoke('file-diff', folder, change),
  gitAction: (folder, action) => ipcRenderer.invoke('git-action', folder, action),
  onDiffSnapshot: (cb) => subscribe('diff-snapshot', cb),
  loadWorkspace: () => ipcRenderer.invoke('load-workspace'),
  saveWorkspace: (snapshot) => ipcRenderer.send('save-workspace', snapshot),
  write: (cardId, data) => ipcRenderer.send('pty-write', cardId, data),
  leaveScrollback: (cardId) => ipcRenderer.invoke('leave-scrollback', cardId),
  resize: (cardId, cols, rows) => ipcRenderer.send('pty-resize', cardId, cols, rows),
  decide: (askId, decision: AskDecision) => ipcRenderer.send('decide-ask', askId, decision),
  releaseAsks: (cardId) => ipcRenderer.send('release-asks', cardId),
  onPtyData: (cb) => subscribe('pty-data', cb),
  onPtyExit: (cb) => subscribe('pty-exit', cb),
  onCardEvent: (cb) => subscribe('card-event', cb),
  onAsk: (cb) => subscribe('permission-ask', cb),
  publishRemoteState: (state) => ipcRenderer.send('publish-remote-state', state),
  checkRemoteReadiness: () => ipcRenderer.invoke('check-remote-readiness'),
  checkAppReadiness: () => ipcRenderer.invoke('check-app-readiness'),
  onAskDecided: (cb) => subscribe('ask-decided', cb),
  openExternal: (url) => ipcRenderer.send('open-external', url),
}

contextBridge.exposeInMainWorld('canvas', api)
