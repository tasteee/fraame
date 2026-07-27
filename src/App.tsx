import { Show, createSignal } from 'solid-js'
import { UploadScreen } from './screens/UploadScreen'
import { ViewerScreen } from './screens/ViewerScreen'
import { createFrameSource, type FrameSourceT } from './lib/frameSource'
import type { ProbeResultT, VideoInfoT } from './lib/video'
import type { Input, InputVideoTrack } from 'mediabunny'

type SessionT = {
  file: File
  input: Input
  track: InputVideoTrack
  info: VideoInfoT
  source: FrameSourceT
}

export const App = () => {
  const [session, setSession] = createSignal<SessionT | null>(null)

  // The probe's Input and track are handed straight to the frame source, so
  // the viewer reads through a file that is already open and parsed. Export
  // shares the same track — media sinks are independent of each other.
  const start = (file: File, probe: ProbeResultT) => {
    const source = createFrameSource({ track: probe.track, info: probe.info })
    setSession({ file, input: probe.input, track: probe.track, info: probe.info, source })
  }

  const reset = () => {
    const active = session()
    active?.source.destroy()
    active?.input.dispose()
    setSession(null)
  }

  return (
    <Show when={session()} fallback={<UploadScreen onStart={start} />}>
      {(active) => (
        <ViewerScreen
          file={active().file}
          track={active().track}
          info={active().info}
          source={active().source}
          onReset={reset}
        />
      )}
    </Show>
  )
}
