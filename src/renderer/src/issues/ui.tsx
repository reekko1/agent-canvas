import {
  forwardRef,
  type ComponentType,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react'
import { Select as SelectPrimitive } from '@base-ui/react/select'
import { Check, ChevronDown } from 'lucide-react'
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

/// A toggle pill — used for dependency selection (click a sibling to depend on
/// it). Active reads as filled; idle as a hairline outline that warms on hover.
export function Chip({
  active,
  onClick,
  children,
  className,
}: {
  active?: boolean
  onClick: () => void
  children: ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
        active
          ? 'border-transparent bg-accent text-foreground'
          : 'border-border text-muted-foreground hover:bg-hover hover:text-foreground',
        className,
      )}
    >
      {children}
    </button>
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

export interface SelectOption<T extends string> {
  value: T
  label: string
  /** Optional leading status dot (e.g. the issue-status palette). */
  color?: string
}

/// A dropdown for longer sets (issue status). Wraps base-ui's Select so the
/// popup is portaled — it never clips against the sheet's scroll container — and
/// each option can carry a status dot. The trigger mirrors the field surface.
export function Select<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: {
  value: T
  onChange: (v: T) => void
  options: SelectOption<T>[]
  ariaLabel?: string
  className?: string
}) {
  const current = options.find((o) => o.value === value)
  return (
    <SelectPrimitive.Root
      value={value}
      onValueChange={(v) => v != null && onChange(v as T)}
    >
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        className={cn(
          'inline-flex h-8 min-w-0 items-center justify-between gap-2 rounded-md border border-border bg-transparent px-2.5 text-xs text-foreground outline-none transition-colors hover:bg-hover focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/15',
          className,
        )}
      >
        <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
          {current?.color && <StatusSwatch color={current.color} />}
          <SelectPrimitive.Value>{current?.label ?? value}</SelectPrimitive.Value>
        </span>
        <SelectPrimitive.Icon className="text-muted-foreground">
          <ChevronDown className="size-3.5" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner side="bottom" align="start" sideOffset={6} className="z-50">
          <SelectPrimitive.Popup className="max-h-[var(--available-height)] min-w-[var(--anchor-width)] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl outline-none">
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs outline-none data-[highlighted]:bg-accent"
              >
                {o.color && <StatusSwatch color={o.color} />}
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="ml-auto text-muted-foreground">
                  <Check className="size-3.5" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}

function StatusSwatch({ color }: { color: string }) {
  return <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
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
