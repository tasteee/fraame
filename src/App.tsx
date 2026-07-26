import { Show, createSignal } from 'solid-js'
import { UploadScreen } from './screens/UploadScreen'
import { ViewerScreen } from './screens/ViewerScreen'
import { createFrameSource, type FrameSourceT } from './lib/frameSource'
import type { ProbeResultT, VideoInfoT } from './lib/video'

type SessionT = {
  file: File
  info: VideoInfoT
  source: FrameSourceT
}

export const App = () => {
  const [session, setSession] = createSignal<SessionT | null>(null)

  // The probe demuxer is handed straight to the frame source, so the viewer
  // opens against an already-loaded WASM instance instead of building another.
  const start = (file: File, probe: ProbeResultT) => {
    const source = createFrameSource({ demuxer: probe.demuxer, info: probe.info })
    setSession({ file, info: probe.info, source })
  }

  const reset = () => {
    session()?.source.destroy()
    setSession(null)
  }

  return (
    <Show when={session()} fallback={<UploadScreen onStart={start} />}>
      {(active) => (
        <ViewerScreen file={active().file} info={active().info} source={active().source} onReset={reset} />
      )}
    </Show>
  )
}
