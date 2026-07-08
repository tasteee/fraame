import { Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js'
import { createBitmapCache } from '../lib/bitmapCache'
import { extractFullResFrame, type FrameT, type VideoInfoT } from '../lib/video'

type PropsT = {
  file: File
  info: VideoInfoT
  frames: FrameT[]
  frameCount: () => number
  isExtracting: () => boolean
  extractError: () => string | null
  onReset: () => void
}

// Vertical movement scrubs fast; horizontal is ~8x finer for landing on an
// exact frame.
const COARSE_PX_PER_FRAME = 6
const FINE_PX_PER_FRAME = 48
const TAP_MAX_MOVEMENT = 12
const TAP_MAX_GAP_MS = 450
const PREFETCH_RADIUS = 20

const formatTime = (sec: number) => {
  const minutes = Math.floor(sec / 60)
  const seconds = Math.floor(sec % 60)
  const millis = Math.floor((sec % 1) * 1000)
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

export const ViewerScreen = (props: PropsT) => {
  const [index, setIndex] = createSignal(0)
  const [toast, setToast] = createSignal<string | null>(null)
  let rootRef: HTMLDivElement | undefined
  let canvasRef: HTMLCanvasElement | undefined

  const cache = createBitmapCache((i) => props.frames[i]?.blob)
  onCleanup(() => cache.clear())

  const clampIndex = (i: number) => Math.max(0, Math.min(props.frameCount() - 1, i))

  let drawSequence = 0
  const draw = async () => {
    const i = index()
    if (props.frameCount() === 0) return
    const sequence = ++drawSequence
    const bitmap = await cache.load(i)
    if (!bitmap || sequence !== drawSequence || !canvasRef) return
    if (canvasRef.width !== bitmap.width) canvasRef.width = bitmap.width
    if (canvasRef.height !== bitmap.height) canvasRef.height = bitmap.height
    canvasRef.getContext('2d')?.drawImage(bitmap, 0, 0)
    cache.prefetch(i, PREFETCH_RADIUS, props.frameCount())
  }

  createEffect(() => {
    index()
    props.frameCount()
    void draw()
  })

  // ---- scrub input ----

  let accumulator = 0
  const advance = (deltaFrames: number) => {
    accumulator += deltaFrames
    const whole = Math.trunc(accumulator)
    if (whole !== 0) {
      accumulator -= whole
      setIndex(clampIndex(index() + whole))
    }
  }

  const onWheel = (event: WheelEvent) => {
    event.preventDefault()
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1
    advance((event.deltaY * scale) / COARSE_PX_PER_FRAME + (event.deltaX * scale) / FINE_PX_PER_FRAME)
  }

  let isDragging = false
  let lastX = 0
  let lastY = 0
  let movement = 0
  let tapTimes: number[] = []

  const onPointerDown = (event: PointerEvent) => {
    isDragging = true
    lastX = event.clientX
    lastY = event.clientY
    movement = 0
    rootRef?.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: PointerEvent) => {
    if (!isDragging) return
    const dx = event.clientX - lastX
    const dy = event.clientY - lastY
    lastX = event.clientX
    lastY = event.clientY
    movement += Math.abs(dx) + Math.abs(dy)
    // Finger up = scroll down = forward; finger right = forward.
    advance(-dy / COARSE_PX_PER_FRAME + dx / FINE_PX_PER_FRAME)
  }

  const onPointerUp = () => {
    if (!isDragging) return
    isDragging = false
    if (movement < TAP_MAX_MOVEMENT) {
      const now = performance.now()
      if (tapTimes.length > 0 && now - tapTimes[tapTimes.length - 1] > TAP_MAX_GAP_MS) {
        tapTimes = []
      }
      tapTimes.push(now)
      if (tapTimes.length >= 3) {
        tapTimes = []
        void downloadCurrentFrame()
      }
    } else {
      tapTimes = []
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowRight') setIndex(clampIndex(index() + 1))
    else if (event.key === 'ArrowLeft') setIndex(clampIndex(index() - 1))
    else if (event.key === 'ArrowDown') setIndex(clampIndex(index() + 10))
    else if (event.key === 'ArrowUp') setIndex(clampIndex(index() - 10))
    else return
    event.preventDefault()
  }

  onMount(() => {
    rootRef?.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKeyDown)
  })
  onCleanup(() => {
    rootRef?.removeEventListener('wheel', onWheel)
    window.removeEventListener('keydown', onKeyDown)
  })

  // ---- download ----

  let isDownloading = false
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  const showToast = (message: string, holdMs?: number) => {
    if (toastTimer) clearTimeout(toastTimer)
    setToast(message)
    if (holdMs) toastTimer = setTimeout(() => setToast(null), holdMs)
  }

  const downloadCurrentFrame = async () => {
    if (isDownloading) return
    const i = index()
    const frame = props.frames[i]
    if (!frame) return
    isDownloading = true
    showToast(`saving frame ${i + 1}…`)
    try {
      const blob = await extractFullResFrame(props.file, props.info, frame.timeSec)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      const base = props.file.name.replace(/\.[^.]+$/, '')
      anchor.href = url
      anchor.download = `${base}-frame-${i + 1}.png`
      anchor.click()
      URL.revokeObjectURL(url)
      showToast(`saved frame ${i + 1}`, 1600)
    } catch {
      showToast('could not save this frame', 2200)
    } finally {
      isDownloading = false
    }
  }

  // ---- readouts ----

  const currentTimeSec = () => {
    props.frameCount()
    return props.frames[index()]?.timeSec ?? 0
  }

  const totalLabel = () => {
    const count = props.frameCount().toLocaleString()
    return props.isExtracting() ? `~${count}` : count
  }

  return (
    <div
      ref={rootRef}
      class="viewer"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        isDragging = false
        tapTimes = []
      }}
    >
      <Show
        when={props.frameCount() > 0}
        fallback={
          <div class="viewer-loading">
            <Show
              when={!props.extractError()}
              fallback={<z-alert tone="danger" heading="extraction failed">{props.extractError()}</z-alert>}
            >
              <z-progress is-indeterminate tone="primary" style="width: 100%"></z-progress>
              <z-text size="sm" color="muted">
                decoding first frame…
              </z-text>
            </Show>
          </div>
        }
      >
        <canvas ref={canvasRef} class="frame-canvas" />
      </Show>

      <div class="overlay top-left" onPointerDown={(event) => event.stopPropagation()}>
        <div class="hud">
          <z-link size="sm" on:click={props.onReset}>
            ↺ start over
          </z-link>
        </div>
      </div>

      <Show when={props.frameCount() > 0}>
        <div class="overlay top-center">
          <div class="hud">
            <z-text size="sm">
              {formatTime(currentTimeSec())} / {formatTime(props.info.durationSec)}
            </z-text>
          </div>
        </div>

        <div class="overlay bottom-center">
          <div class="hud">
            <z-text size="sm">
              frame {(index() + 1).toLocaleString()} / {totalLabel()}
            </z-text>
            <Show when={props.isExtracting()}>
              <z-badge tone="info" size="sm" label="extracting…"></z-badge>
            </Show>
            <Show when={props.extractError()}>
              <z-badge tone="danger" size="sm" label="extraction stopped early"></z-badge>
            </Show>
          </div>
        </div>
      </Show>

      <Show when={toast()}>
        <div class="overlay center-toast">
          <div class="hud">
            <z-text size="sm">{toast()}</z-text>
          </div>
        </div>
      </Show>
    </div>
  )
}
