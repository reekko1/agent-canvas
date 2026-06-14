import { useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  AskUserQuestions,
  type AskUserAnswer,
  type AskUserQuestion,
} from '@/components/ui/ask-user-questions'
import type { QuestionAnswers, QuestionAskInfo } from '@shared/types'
import type { AskContext } from './AskToasts'

/// Held AskUserQuestion asks as a chooser stack: the agent needs YOU to decide,
/// so it shows the question(s) and their options (via the design-system
/// AskUserQuestions component) instead of an Allow/Deny gate. Answering from
/// orbit injects the choice into the tool input; clicking the header flies to
/// the card, releasing it to the terminal picker. (Rendered inside the shared
/// bottom overlay alongside AskToasts.)
export function QuestionToasts({
  questions,
  contextFor,
  onAnswer,
  onDecline,
  onBodyClick,
}: {
  questions: QuestionAskInfo[]
  contextFor: (cardId: string) => AskContext
  onAnswer: (askId: string, answers: QuestionAnswers) => void
  onDecline: (askId: string) => void
  onBodyClick: (ask: QuestionAskInfo) => void
}) {
  return (
    <AnimatePresence>
      {questions.map((ask) => (
        <QuestionCard
          key={ask.askId}
          ask={ask}
          ctx={contextFor(ask.cardId)}
          onAnswer={onAnswer}
          onDecline={onDecline}
          onBodyClick={onBodyClick}
        />
      ))}
    </AnimatePresence>
  )
}

function QuestionCard({
  ask,
  ctx,
  onAnswer,
  onDecline,
  onBodyClick,
}: {
  ask: QuestionAskInfo
  ctx: AskContext
  onAnswer: (askId: string, answers: QuestionAnswers) => void
  onDecline: (askId: string) => void
  onBodyClick: (ask: QuestionAskInfo) => void
}) {
  // Adapt our Question[] → the component's shape. The question text is the id,
  // so onComplete's answer keys map straight back; option labels are option ids.
  const uiQuestions = useMemo<AskUserQuestion[]>(
    () =>
      ask.questions.map((q) => ({
        id: q.question,
        title: q.question,
        options: q.options.map((o) => ({ id: o.label, title: o.label, description: o.description })),
        multiSelect: q.multiSelect,
        // The CLI's AskUserQuestion always offers a free-text answer; mirror it.
        allowOther: true,
        // Descriptions are common and wrap — stacked reads better than inline.
        layout: q.options.some((o) => o.description) ? 'stacked' : 'inline',
      })),
    [ask.questions],
  )

  const handleComplete = (answers: Record<string, AskUserAnswer>): void => {
    const out: QuestionAnswers = {}
    for (const q of ask.questions) {
      const a = answers[q.question]
      if (!a || a.skipped) continue
      const parts = [...a.selectedIds] // option ids === labels
      const custom = a.otherText?.trim()
      if (custom) parts.push(custom)
      if (parts.length) out[q.question] = parts.join(', ')
    }
    // Nothing chosen (all skipped/empty) reads as a decline, which the CLI
    // records as "User declined to answer questions".
    if (Object.keys(out).length === 0) onDecline(ask.askId)
    else onAnswer(ask.askId, out)
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 24, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 24, scale: 0.97 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className="pointer-events-auto w-[33rem] max-w-[92vw]"
    >
      {/* Who's asking + fly-to-card affordance (releases to the terminal). */}
      <div
        className="mb-1.5 flex cursor-pointer items-center gap-2 px-1"
        onClick={() => onBodyClick(ask)}
        title="Click to fly to the card (the question moves to its terminal)"
      >
        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" />
        <span className="text-sm font-medium text-foreground">{ctx.name}</span>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-primary">asks</span>
        {ctx.task && (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{ctx.task}</span>
        )}
      </div>

      <AskUserQuestions
        questions={uiQuestions}
        onComplete={handleComplete}
        className="shadow-lg shadow-black/15"
      />
    </motion.div>
  )
}
