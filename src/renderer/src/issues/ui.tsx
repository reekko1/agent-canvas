import {
  forwardRef,
  useEffect,
  type ComponentType,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { IconComponent } from '@/lib/icon-context'

/// The shared vocabulary for the issue board — the primitives every panel is
/// built from, so there is exactly one definition of a label, an input, a
/// composer, a select. Two ideas carry the whole look: a tight type scale
/// (13px content / 12px body / 11px meta — nothing smaller) and hierarchy by
/// weight + color, never by shouting (no heavy borders, no uppercase walls).

/// Wrap a Lucide icon as a `Button` leadingIcon (whose prop types are narrower
/// than Lucide's — `size` differs, so the strict shape won't accept it; the icon
/// registry uses the same `any` escape hatch). One adapter, not a per-file
/// re-declaration.
export const asIcon =
  (Icon: ComponentType<any>): IconComponent =>
  (props) =>
    <Icon {...props} />

/// A small section header: "Sprints 3", "Depends on", "History". Sentence case,
/// medium weight, muted — the count dims further so the word leads. An optional
/// trailing `action` (an "Assess" link, etc.) right-aligns.
export function SectionLabel({
  children,
  count,
  action,
  className,
}: {
  children: ReactNode
  count?: number
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span className="text-[11px] font-medium text-muted-foreground">
        {children}
        {count !== undefined && <span className="ml-1.5 text-muted-foreground/50">{count}</span>}
      </span>
      {action && <span className="ml-auto">{action}</span>}
    </div>
  )
}

/// A labeled form control: the label sits above the control, an optional `hint`
/// below (used for the vision-class explanations).
export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="block text-[11px] leading-relaxed text-muted-foreground/70">{hint}</span>}
    </label>
  )
}

// One definition of the field surface — a hairline box that warms on focus with
// a soft ring (no harsh outline). Shared by the input and the textarea.
const fieldSurface =
  'w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground/60 focus:border-ring focus:ring-2 focus:ring-ring/15'

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn(fieldSurface, className)} {...props} />
  ),
)
TextInput.displayName = 'TextInput'

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(fieldSurface, 'resize-y leading-relaxed', className)} {...props} />
  ),
)
TextArea.displayName = 'TextArea'

/// The one inline-form shell: a faint bordered card holding the fields, with a
/// primary submit + optional Cancel footer. Replaces the open→fields→Create/
/// Cancel pattern that was hand-rolled in every composer.
export function InlineComposer({
  children,
  submitLabel,
  onSubmit,
  canSubmit = true,
  onCancel,
  className,
}: {
  children: ReactNode
  submitLabel: string
  onSubmit: () => void
  canSubmit?: boolean
  onCancel?: () => void
  className?: string
}) {
  return (
    <div className={cn('space-y-2.5 rounded-lg border border-border bg-muted/30 p-3', className)}>
      {children}
      <div className="flex items-center gap-2 pt-0.5">
        <Button onClick={onSubmit} disabled={!canSubmit}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}

/// A segmented control for small mutually-exclusive sets (kind, verdict, vision
/// class) — more legible and tactile than a dropdown when there are 2–3 options.
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
  className?: string
}) {
  return (
    <div className={cn('inline-flex items-center gap-0.5 rounded-md border border-border p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-[5px] px-2.5 py-1 text-[11px] font-medium transition-colors',
            value === o.value
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/// A centered, quiet placeholder for an empty pane.
export function EmptyState({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex h-full items-center justify-center px-6 text-center text-xs leading-relaxed text-muted-foreground',
        className,
      )}
    >
      {children}
    </div>
  )
}

/// The node inspector: a bottom slide-over scoped to the sheet body (its nearest
/// `relative` ancestor — the Frontier stays the hero behind a dimmed backdrop).
/// Esc or a backdrop click closes; mounted only while open so the slide-up plays
/// fresh each time. `title` is a node so callers own its typography.
export function Drawer({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="absolute inset-0 z-30 flex flex-col justify-end">
      <button
        aria-label="Close inspector"
        className="absolute inset-0 bg-background/45 backdrop-blur-[1px]"
        onClick={onClose}
      />
      <div className="drawer-up relative flex max-h-[80%] flex-col overflow-hidden rounded-t-2xl border-t border-border bg-card shadow-2xl">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
          <div className="min-w-0 flex-1">{title}</div>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            <X />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
      </div>
    </div>
  )
}

// Tiny shared parsers for the comma / newline list fields.
export const csvToList = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

export const linesToList = (s: string): string[] =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
