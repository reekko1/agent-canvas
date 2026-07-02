import { TooltipProvider } from '@/components/ui/tooltip'
import { SetupGate } from '@/setup/SetupGate'
import { Canvas } from './canvas/Canvas'

export function App() {
  return (
    <TooltipProvider>
      <Canvas />
      {/* Above everything: the canvas is unusable until claude exists. */}
      <SetupGate />
    </TooltipProvider>
  )
}
