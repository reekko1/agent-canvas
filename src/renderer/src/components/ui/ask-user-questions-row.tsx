"use client";

import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { spring } from "@/lib/springs";
import { fontWeights } from "@/lib/font-weight";
import { useShape } from "@/lib/shape-context";

// ── Shortcut chip ─────────────────────────────────────────────
// Small keycap showing the keyboard shortcut for an action, so Back (←),
// Skip (→) and Continue (⌘↵ / ⌃↵) all read consistently. `tone="inverted"`
// sits on the dark primary button; the default reads on quiet ghost buttons.
export function ShortcutChip({
  children,
  tone = "muted",
  shape,
}: {
  children: React.ReactNode;
  tone?: "muted" | "inverted";
  shape: ReturnType<typeof useShape>;
}) {
  return (
    <kbd
      aria-hidden
      className={cn(
        "inline-flex items-center justify-center gap-0.5 px-1 min-w-[18px] h-[18px] text-[11px] leading-none font-sans tracking-wide",
        tone === "inverted"
          ? "bg-background/15 text-background"
          : "bg-foreground/10 text-muted-foreground",
        shape.bg
      )}
    >
      {children}
    </kbd>
  );
}

// ── Row sub-component ─────────────────────────────────────────

export interface RowProps {
  index: number;
  registerItem: (index: number, element: HTMLElement | null) => void;
  role: "radio" | "checkbox" | null;
  isSelected: boolean;
  tabIndex: number;
  onFocusVisible: () => void;
  onBlurAny: () => void;
  onClick: () => void;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  shape: ReturnType<typeof useShape>;
  chipContent: React.ReactNode;
  chipFilled: boolean;
  isMulti: boolean;
  ariaLabel?: string;
  "aria-checked"?: boolean;
  showArrow?: boolean;
  arrowIcon?: React.ReactNode;
  onArrowClick?: () => void;
  /** Body content layout. "inline" keeps title + description on one line;
   *  "stacked" puts description below the title with extra vertical padding. */
  bodyLayout?: "inline" | "stacked";
  /** Anchor the chip to the first line of the body instead of vertically
   *  centering it on the row. Use when the body can grow taller than one
   *  line (Other row's textarea, stacked title + description, or any
   *  wrapping content) — otherwise the chip drifts toward the middle of a
   *  tall row and stops reading as a marker for the row's title. */
  topAlign?: boolean;
  /** Mirrors the per-question `chipPosition`. "left" moves the chip to
   *  the leading edge of the row; the trailing arrow slot still sits on
   *  the right. Defaults to "right". */
  chipPosition?: "left" | "right";
  children: React.ReactNode;
}

export function Row({
  index,
  registerItem,
  role,
  isSelected,
  tabIndex,
  onFocusVisible,
  onBlurAny,
  onClick,
  onKeyDown,
  shape,
  chipContent,
  chipFilled,
  isMulti,
  ariaLabel,
  showArrow,
  arrowIcon,
  onArrowClick,
  bodyLayout = "inline",
  topAlign = false,
  chipPosition = "right",
  children,
  ...aria
}: RowProps) {
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    registerItem(index, rowRef.current);
    return () => registerItem(index, null);
  }, [index, registerItem]);

  // The arrow keeps the same animation regardless of which slot it lands
  // in — pull it out so the chip-on-right (overlay) and chip-on-left
  // (separate right slot) paths can reuse the exact same element.
  const arrowOverlay = (
    <AnimatePresence>
      {showArrow && (
        <motion.span
          aria-hidden={!onArrowClick}
          role={onArrowClick ? "button" : undefined}
          onClick={
            onArrowClick
              ? (e) => {
                  e.stopPropagation();
                  onArrowClick();
                }
              : undefined
          }
          className={cn(
            "absolute inset-0 inline-flex items-center justify-center bg-foreground text-background",
            shape.bg,
            onArrowClick && "cursor-pointer"
          )}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{
            opacity: 0,
            scale: 0.6,
            transition: spring.fast.exit,
          }}
          transition={{
            ...spring.fast,
            opacity: { duration: 0.08 },
          }}
        >
          {arrowIcon}
        </motion.span>
      )}
    </AnimatePresence>
  );

  // The chip "slot" is a fixed 28×28 cell holding the chip number/circle.
  // When topAlign is on, the slot floats up so the chip's vertical centre
  // lines up with the centre of a `text-[13px] leading-snug` first line
  // (line-height ≈ 18px → centre 9px; chip centre 14px → diff 5px).
  // Stacked rows pair a title with a description, so we add 4px of
  // breathing room back on top (effective shift -1px) — that lands the
  // chip near the title's baseline rather than its optical centre, which
  // reads as "row marker" instead of "title label" when descriptions wrap.
  // The arrow overlay only co-renders here when `chipPosition === "right"`
  // — in chip-on-left mode the arrow has its own right-edge slot so the
  // chip stays visible while the submit affordance lives where users
  // expect it (the trailing end of the row).
  const chipSlot = (
    <span
      className={cn(
        "shrink-0 w-7 h-7 relative inline-flex items-center justify-center",
        topAlign &&
          (bodyLayout === "stacked" ? "-mt-[1px]" : "-mt-[5px]")
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inline-flex items-center justify-center w-5 h-5 text-[11px] transition-[opacity,font-variation-settings] duration-80",
          isMulti && shape.bg,
          isMulti
            ? chipFilled
              ? "bg-foreground text-background"
              : "border border-border text-muted-foreground"
            : chipFilled
            ? "text-foreground"
            : "text-muted-foreground",
          // Only fade the chip when it shares a slot with the arrow — for
          // chip-on-left the arrow has its own slot on the right, so the
          // chip stays in place.
          chipPosition === "right" && showArrow && "opacity-0"
        )}
        style={{
          fontVariationSettings: chipFilled
            ? fontWeights.semibold
            : fontWeights.medium,
        }}
      >
        {chipContent}
      </span>
      {chipPosition === "right" && arrowOverlay}
    </span>
  );

  // Right-edge arrow slot — only used when the chip is on the LEFT and
  // the row can show an arrow (single-select only; in multi-select
  // showArrow is always false and there's nothing to anchor here). Mirrors
  // the chip slot's stacked-vs-inline shift so both end markers stay on
  // the same horizontal line at all times.
  const rightArrowSlot = chipPosition === "left" && !isMulti && (
    <span
      className={cn(
        "shrink-0 w-7 h-7 relative inline-flex items-center justify-center",
        topAlign &&
          (bodyLayout === "stacked" ? "-mt-[1px]" : "-mt-[5px]")
      )}
    >
      {arrowOverlay}
    </span>
  );

  return (
    <div
      ref={rowRef}
      data-proximity-index={index}
      data-state={isSelected ? "checked" : "unchecked"}
      role={role ?? undefined}
      aria-checked={role === "radio" || role === "checkbox" ? !!aria["aria-checked"] : undefined}
      aria-label={ariaLabel}
      tabIndex={tabIndex}
      onFocus={(e) => {
        if ((e.target as HTMLElement).matches(":focus-visible")) {
          onFocusVisible();
        }
      }}
      onBlur={onBlurAny}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={cn(
        "relative z-10 flex cursor-pointer select-none outline-none",
        // Tighter gap when the chip sits on the left — it reads as a
        // leading list marker, so coupling it close to the title looks
        // more intentional than the larger right-side gap (where the
        // chip is a trailing affordance instead).
        chipPosition === "left" ? "gap-2" : "gap-3",
        // items-start when the body may exceed one line (stacked layouts,
        // multi-line textareas) so the chip tracks the first line instead
        // of sliding to the row's vertical centre. When topAlign is OFF,
        // items-center keeps a 1-line row visually centred — that's why
        // the Other row defers topAlign until its textarea actually wraps.
        topAlign ? "items-start" : "items-center",
        bodyLayout === "stacked" ? "min-h-14 py-2" : "min-h-10 py-1.5",
        // Mirror the horizontal padding based on chip side so the row
        // reads visually balanced in both orientations. For chip-on-left
        // + multi-select there's no right slot, so widen the right padding
        // to match the chip-on-right's 12px / 6px asymmetry mirrored.
        chipPosition === "left"
          ? isMulti
            ? "pl-1.5 pr-3"
            : "pl-1.5 pr-1.5"
          : "pl-3 pr-1.5",
        shape.item
      )}
    >
      {/* Selected background is drawn at the container level so contiguous
          selections can merge into a single block (see AskUserQuestions's
          selectedGroups / merged-bg block). Row keeps z-10 to sit above it. */}

      {chipPosition === "left" && chipSlot}

      {/* Body — fills row */}
      <span
        className={cn(
          "min-w-0 flex-1 text-[13px] leading-snug",
          bodyLayout === "stacked"
            ? "flex flex-col gap-0.5"
            : "inline-flex items-center gap-0"
        )}
      >
        {children}
      </span>

      {chipPosition === "right" ? chipSlot : rightArrowSlot}
    </div>
  );
}
