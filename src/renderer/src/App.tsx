import { ReactFlowProvider } from '@xyflow/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SetupGate } from '@/setup/SetupGate'
import { Canvas } from './canvas/Canvas'

export function App() {
  return (
    <TooltipProvider>
      <ReactFlowProvider>
        <Canvas />
        {/* Above everything: the canvas is unusable until claude + tmux exist. */}
        <SetupGate />
      </ReactFlowProvider>
    </TooltipProvider>
  )
}
