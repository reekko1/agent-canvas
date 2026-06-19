/// Rename-a-card modal. Electron has no `window.prompt`, so renames render this
/// custom input. Click-away (overlay mousedown) and Escape cancel; Enter / the
/// Rename button commit.
export function RenameDialog(props: {
  value: string
  onChange: (value: string) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  const { value, onChange, onCancel, onSubmit } = props
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onMouseDown={onCancel}
    >
      <div
        className="w-80 rounded-xl border border-border/40 bg-popover/95 p-4 shadow-2xl backdrop-blur-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <p className="mb-2 font-mono text-xs text-muted-foreground">Rename card</p>
        <input
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit()
            else if (e.key === 'Escape') onCancel()
          }}
          placeholder="Name"
          className="w-full rounded-lg border border-border/40 bg-background px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-border"
        />
        <div className="mt-3 flex justify-end gap-2 font-mono text-xs">
          <button
            className="rounded-lg px-3 py-1.5 text-muted-foreground hover:bg-accent"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="rounded-lg bg-foreground/10 px-3 py-1.5 text-foreground hover:bg-foreground/20"
            onClick={onSubmit}
          >
            Rename
          </button>
        </div>
      </div>
    </div>
  )
}
