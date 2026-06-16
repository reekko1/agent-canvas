import { useCallback, useEffect, useRef, useState } from 'react'
import type { QuestionAnswers, QuestionAskInfo } from '@shared/types'

/** A held question plus its arrival time (parity with PendingAsk). */
export interface PendingQuestion extends QuestionAskInfo {
  created: number
}

/// Held AskUserQuestion asks, projected for the chooser toast. Mirrors
/// usePendingAsks' lifecycle (release on forward progress / pty death / fly-in),
/// but answers by choosing options rather than allow/deny — the two are
/// deliberately separate flows because a question is not a permission gate.
export function usePendingQuestions() {
  const [questions, setQuestions] = useState<PendingQuestion[]>([])
  // Mirror for the event handler — releasing must not read stale closure state.
  const ref = useRef(questions)
  ref.current = questions

  /** Release a card's questions with no answer — the picker falls through to its
   *  terminal. Called on terminal engagement, forward progress, and pty death. */
  const releaseCard = useCallback((cardId: string) => {
    if (!ref.current.some((q) => q.cardId === cardId)) return
    window.canvas.releaseAsks(cardId)
    setQuestions((qs) => qs.filter((q) => q.cardId !== cardId))
  }, [])

  useEffect(() => {
    const offQuestion = window.canvas.onQuestion((q) =>
      setQuestions((qs) => [...qs, { ...q, created: Date.now() }]),
    )
    const offEvent = window.canvas.onCardEvent((cardId, ev) => {
      // Forward progress resolves a card's held question (answered in the
      // terminal, hook timed out, or the turn moved on).
      if (ev.status && ev.status !== 'blocked') releaseCard(cardId)
    })
    const offExit = window.canvas.onPtyExit(releaseCard)
    // Answered/declined from the phone — clear the desktop chooser too.
    const offDecided = window.canvas.onQuestionDecided((askId) =>
      setQuestions((qs) => qs.filter((q) => q.askId !== askId)),
    )
    return () => {
      offQuestion()
      offEvent()
      offExit()
      offDecided()
    }
  }, [releaseCard])

  /** Answer with the chosen option(s) — the agent proceeds without the terminal. */
  const answer = useCallback((askId: string, answers: QuestionAnswers) => {
    window.canvas.answerQuestion(askId, answers)
    setQuestions((qs) => qs.filter((q) => q.askId !== askId))
  }, [])

  /** Decline — the CLI records "User declined to answer questions". */
  const decline = useCallback((askId: string) => {
    window.canvas.decide(askId, 'deny')
    setQuestions((qs) => qs.filter((q) => q.askId !== askId))
  }, [])

  return { questions, answer, decline, releaseCard }
}
