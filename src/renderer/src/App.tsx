import { ReactFlowProvider } from '@xyflow/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Canvas } from './canvas/Canvas'

export function App() {
  return (
    <TooltipProvider>
      <ReactFlowProvider>
        <Canvas />
      </ReactFlowProvider>
    </TooltipProvider>
  )
}
