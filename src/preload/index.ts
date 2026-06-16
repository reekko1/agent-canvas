import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AskDecision, CanvasApi, QuestionAnswers } from '../shared/types'

function subscribe(channel: string, cb: (...args: any[]) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: any[]): void => cb(...args)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

const api: CanvasApi = {
  newCard: (folder) => ipcRenderer.invoke('new-card', folder),
  newShell: (folder) => ipcRenderer.invoke('new-shell', folder),
  pickFolder: (message) => ipcRenderer.invoke('pick-folder', message),
  ensureCard: (cardId, folder, cols, rows, kind) =>
    ipcRenderer.invoke('ensure-card', cardId, folder, cols, rows, kind),
  killCard: (cardId) => ipcRenderer.invoke('kill-card', cardId),
  readTodos: (sessionId) => ipcRenderer.invoke('read-todos', sessionId),
  paneCommand: (cardId) => ipcRenderer.invoke('pane-command', cardId),
  paneCwd: (cardId) => ipcRenderer.invoke('pane-cwd', cardId),
  watchDiff: (diffId, folder) => ipcRenderer.invoke('watch-diff', diffId, folder),
  unwatchDiff: (diffId) => ipcRenderer.send('unwatch-diff', diffId),
  readFileDiff: (folder, change) => ipcRenderer.invoke('file-diff', folder, change),
  gitAction: (folder, action) => ipcRenderer.invoke('git-action', folder, action),
  repoIdentity: (folder) => ipcRenderer.invoke('repo-identity', folder),
  revealFolder: (folder) => ipcRenderer.invoke('reveal-folder', folder),
  openInEditor: (folder) => ipcRenderer.invoke('open-in-editor', folder),
  onDiffSnapshot: (cb) => subscribe('diff-snapshot', cb),
  loadWorkspace: () => ipcRenderer.invoke('load-workspace'),
  saveWorkspace: (snapshot) => ipcRenderer.send('save-workspace', snapshot),
  write: (cardId, data) => ipcRenderer.send('pty-write', cardId, data),
  leaveScrollback: (cardId) => ipcRenderer.invoke('leave-scrollback', cardId),
  resize: (cardId, cols, rows) => ipcRenderer.send('pty-resize', cardId, cols, rows),
  decide: (askId, decision: AskDecision) => ipcRenderer.send('decide-ask', askId, decision),
  answerQuestion: (askId, answers: QuestionAnswers) =>
    ipcRenderer.send('answer-question', askId, answers),
  releaseAsks: (cardId) => ipcRenderer.send('release-asks', cardId),
  onPtyData: (cb) => subscribe('pty-data', cb),
  onPtyExit: (cb) => subscribe('pty-exit', cb),
  onCardEvent: (cb) => subscribe('card-event', cb),
  onAsk: (cb) => subscribe('permission-ask', cb),
  onQuestion: (cb) => subscribe('question-ask', cb),
  publishRemoteState: (state) => ipcRenderer.send('publish-remote-state', state),
  checkRemoteReadiness: () => ipcRenderer.invoke('check-remote-readiness'),
  checkAppReadiness: () => ipcRenderer.invoke('check-app-readiness'),
  onAskDecided: (cb) => subscribe('ask-decided', cb),
  onQuestionDecided: (cb) => subscribe('question-decided', cb),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  onUpdateStatus: (cb) => subscribe('update-status', cb),
  quitAndInstall: () => ipcRenderer.send('quit-and-install'),
}

contextBridge.exposeInMainWorld('canvas', api)
