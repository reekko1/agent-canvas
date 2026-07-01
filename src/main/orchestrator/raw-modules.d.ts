// Vite `?raw` imports return the file's text content as a string, inlined at build
// time. Used to bundle the pinned idea-tournament workflow (tournamentWorkflow.js)
// into the main process without runtime path resolution. (Vite/electron-vite core feature.)
declare module '*?raw' {
  const content: string
  export default content
}
