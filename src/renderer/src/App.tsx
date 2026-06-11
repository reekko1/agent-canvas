import { ReactFlowProvider } from '@xyflow/react'
import { Canvas } from './canvas/Canvas'

export function App() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  )
}
