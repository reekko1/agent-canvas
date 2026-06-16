import { useCallback } from 'react'
import type { QuestionAnswers, QuestionAskInfo } from '@shared/types'
import { useHeldAsks } from './useHeldAsks'

/** A held question plus its arrival time (parity with PendingAsk). */
export interface PendingQuestion extends QuestionAskInfo {
  created: number
}

/// Held AskUserQuestion asks, projected for the chooser toast. Shares the
/// held-ask lifecycle with usePendingAsks (release on forward progress / pty
/// death / fly-in via useHeldAsks), but answers by choosing options rather than
/// allow/deny — the two stay separate flows because a question is not a
/// permission gate.
export function usePendingQuestions() {
  const { items, setItems, releaseCard } = useHeldAsks<QuestionAskInfo>({
    subscribeArrival: window.canvas.onQuestion,
    subscribeDecided: window.canvas.onQuestionDecided,
  })
  const questions: PendingQuestion[] = items

  /** Answer with the chosen option(s) — the agent proceeds without the terminal. */
  const answer = useCallback(
    (askId: string, answers: QuestionAnswers) => {
      window.canvas.answerQuestion(askId, answers)
      setItems((qs) => qs.filter((q) => q.askId !== askId))
    },
    [setItems],
  )

  /** Decline — the CLI records "User declined to answer questions". */
  const decline = useCallback(
    (askId: string) => {
      window.canvas.decide(askId, 'deny')
      setItems((qs) => qs.filter((q) => q.askId !== askId))
    },
    [setItems],
  )

  return { questions, answer, decline, releaseCard }
}
