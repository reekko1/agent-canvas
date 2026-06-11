// Static assets imported as URLs (Vite emits the file and returns its path).
declare module '*.mp4' {
  const src: string
  export default src
}
