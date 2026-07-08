import { Show, batch, createSignal } from 'solid-js'
import { UploadScreen } from './screens/UploadScreen'
import { ViewerScreen } from './screens/ViewerScreen'
import { extractFrames, type FrameT, type ProbeResultT } from './lib/video'

type SessionT = {
  file: File
  probe: ProbeResultT
  abort: AbortController
}

export const App = () => {
  const [stage, setStage] = createSignal<'pick' | 'view'>('pick')
  const [frameCount, setFrameCount] = createSignal(0)
  const [isExtracting, setIsExtracting] = createSignal(false)
  const [extractError, setExtractError] = createSignal<string | null>(null)
  const [session, setSession] = createSignal<SessionT | null>(null)
  // Frames live in a plain array (blobs, potentially thousands); frameCount is
  // the reactive signal the UI tracks.
  let frames: FrameT[] = []

  const start = (file: File, probe: ProbeResultT, extractFps: number) => {
    const abort = new AbortController()
    setSession({ file, probe, abort })
    frames = []
    batch(() => {
      setFrameCount(0)
      setExtractError(null)
      setIsExtracting(true)
      setStage('view')
    })

    const maxDim = Math.min(
      2560,
      Math.round(Math.max(window.innerWidth, window.innerHeight) * (window.devicePixelRatio || 1)),
    )

    extractFrames({
      demuxer: probe.demuxer,
      info: probe.info,
      extractFps,
      maxDim,
      signal: abort.signal,
      onFrame: (frame) => {
        frames.push(frame)
        setFrameCount(frames.length)
      },
    })
      .catch((error: Error) => {
        if (!abort.signal.aborted) setExtractError(error.message || 'Something went wrong while decoding.')
      })
      .finally(() => {
        if (!abort.signal.aborted) setIsExtracting(false)
      })
  }

  const reset = () => {
    session()?.abort.abort()
    session()?.probe.demuxer.destroy()
    setSession(null)
    frames = []
    batch(() => {
      setFrameCount(0)
      setIsExtracting(false)
      setExtractError(null)
      setStage('pick')
    })
  }

  return (
    <Show when={stage() === 'view' ? session() : null} fallback={<UploadScreen onStart={start} />}>
      {(active) => (
        <ViewerScreen
          file={active().file}
          info={active().probe.info}
          frames={frames}
          frameCount={frameCount}
          isExtracting={isExtracting}
          extractError={extractError}
          onReset={reset}
        />
      )}
    </Show>
  )
}
