import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js'
import type { FrameSourceT } from '../lib/frameSource'
import { extractFullResFrame, releaseFullResDemuxer, type VideoInfoT } from '../lib/video'

type PropsT = {
  file: File
  info: VideoInfoT
  source: FrameSourceT
  onReset: () => void
}

// Vertical movement scrubs fast; horizontal is ~8x finer for landing on an
// exact frame.
const COARSE_PX_PER_FRAME = 6
const FINE_PX_PER_FRAME = 48
const TAP_MAX_MOVEMENT = 12
const TAP_MAX_GAP_MS = 450
const VIEW_ROTATIONS = [0, 90, 180, 270] as const

// Mid-drag the index changes on every pointer event. Waiting for it to settle
// keeps a fast scrub from queueing a decode for frames nobody will look at.
const DECODE_SETTLE_MS = 70

type ViewRotationT = (typeof VIEW_ROTATIONS)[number]

type SaveToastStatusT = 'saving' | 'saved' | 'error'

type SaveToastT = {
  id: number
  frameIndex: number
  status: SaveToastStatusT
}

const formatTime = (sec: number) => {
  const minutes = Math.floor(sec / 60)
  const seconds = Math.floor(sec % 60)
  const millis = Math.floor((sec % 1) * 1000)
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

export const ViewerScreen = (props: PropsT) => {
  const [index, setIndex] = createSignal(0)
  const [saveToasts, setSaveToasts] = createSignal<SaveToastT[]>([])
  const [viewRotation, setViewRotation] = createSignal<ViewRotationT>(0)
  const [hasPainted, setHasPainted] = createSignal(false)
  const [decodeError, setDecodeError] = createSignal<string | null>(null)
  let rootRef: HTMLDivElement | undefined
  let canvasRef: HTMLCanvasElement | undefined

  onCleanup(() => releaseFullResDemuxer())

  const frameCount = () => props.source.frameCount
  const clampIndex = (i: number) => Math.max(0, Math.min(frameCount() - 1, i))

  // ---- painting ----

  const paint = (bitmap: ImageBitmap, rotation: ViewRotationT) => {
    if (!canvasRef) return
    const isSideways = rotation === 90 || rotation === 270
    const width = isSideways ? bitmap.height : bitmap.width
    const height = isSideways ? bitmap.width : bitmap.height
    if (canvasRef.width !== width) canvasRef.width = width
    if (canvasRef.height !== height) canvasRef.height = height

    const ctx = canvasRef.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvasRef.width, canvasRef.height)
    ctx.save()
    if (rotation === 90) {
      ctx.translate(canvasRef.width, 0)
      ctx.rotate(Math.PI / 2)
    } else if (rotation === 180) {
      ctx.translate(canvasRef.width, canvasRef.height)
      ctx.rotate(Math.PI)
    } else if (rotation === 270) {
      ctx.translate(0, canvasRef.height)
      ctx.rotate(-Math.PI / 2)
    }
    ctx.drawImage(bitmap, 0, 0)
    ctx.restore()
    setHasPainted(true)
  }

  // Draws the best frame already in memory. During a fast scrub that is a
  // near neighbour rather than the exact frame, which reads as a slightly
  // soft scrub instead of a stalled one.
  const paintBestAvailable = (i: number, rotation: ViewRotationT) => {
    const exact = props.source.getCached(i)
    if (exact) {
      paint(exact, rotation)
      return true
    }

    const nearest = props.source.getNearestCached(i)
    if (nearest) paint(nearest, rotation)
    return false
  }

  let settleTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    if (settleTimer) clearTimeout(settleTimer)
  })

  const resolveExactFrame = async (i: number) => {
    try {
      const bitmap = await props.source.requestFrame(i)
      if (!bitmap || index() !== i) return
      paint(bitmap, viewRotation())
      setDecodeError(null)
    } catch {
      setDecodeError('could not decode this part of the video')
    }
  }

  const scheduleExactFrame = (i: number) => {
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => void resolveExactFrame(i), DECODE_SETTLE_MS)
  }

  createEffect(() => {
    const i = index()
    const rotation = viewRotation()
    const isExact = paintBestAvailable(i, rotation)
    if (isExact) return
    scheduleExactFrame(i)
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

  const toastTimers = new Map<number, ReturnType<typeof setTimeout>>()
  let nextToastId = 0

  const clearToastTimer = (id: number) => {
    const timer = toastTimers.get(id)
    if (!timer) return
    clearTimeout(timer)
    toastTimers.delete(id)
  }

  const removeSaveToast = (id: number) => {
    clearToastTimer(id)
    setSaveToasts((entries) => entries.filter((entry) => entry.id !== id))
  }

  const scheduleToastRemoval = (id: number, delayMs: number) => {
    clearToastTimer(id)
    toastTimers.set(
      id,
      setTimeout(() => removeSaveToast(id), delayMs),
    )
  }

  const updateSaveToastStatus = (id: number, status: SaveToastStatusT) => {
    setSaveToasts((entries) => entries.map((entry) => (entry.id === id ? { ...entry, status } : entry)))
  }

  const addSaveToast = (frameIndex: number): number => {
    const id = nextToastId++
    setSaveToasts((entries) => [...entries, { id, frameIndex, status: 'saving' }])
    return id
  }

  const getSaveToastLabel = (entry: SaveToastT): string => {
    const frameNumber = entry.frameIndex + 1
    if (entry.status === 'saving') return `saving frame ${frameNumber}…`
    if (entry.status === 'error') return `could not save frame ${frameNumber}`
    return `saved frame ${frameNumber}`
  }

  onCleanup(() => {
    for (const timer of toastTimers.values()) clearTimeout(timer)
  })

  const downloadCurrentFrame = async () => {
    const i = index()
    const isAlreadySavingThisFrame = saveToasts().some((entry) => entry.frameIndex === i && entry.status === 'saving')
    if (isAlreadySavingThisFrame) return

    const toastId = addSaveToast(i)
    try {
      const timeSec = props.source.getTimeSec(i)
      const blob = await extractFullResFrame(props.file, props.info, timeSec, viewRotation())
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      const base = props.file.name.replace(/\.[^.]+$/, '')
      anchor.href = url
      anchor.download = `${base}-frame-${i + 1}.png`
      anchor.click()
      URL.revokeObjectURL(url)
      updateSaveToastStatus(toastId, 'saved')
      scheduleToastRemoval(toastId, 1600)
    } catch {
      updateSaveToastStatus(toastId, 'error')
      scheduleToastRemoval(toastId, 2200)
    }
  }

  // ---- readouts ----

  const currentTimeSec = () => props.source.getTimeSec(index())

  const rotateView = () => {
    const currentIndex = VIEW_ROTATIONS.indexOf(viewRotation())
    setViewRotation(VIEW_ROTATIONS[(currentIndex + 1) % VIEW_ROTATIONS.length])
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
      <canvas ref={canvasRef} class="frame-canvas" classList={{ 'is-hidden': !hasPainted() }} />

      <Show when={!hasPainted()}>
        <div class="viewer-loading">
          <Show
            when={!decodeError()}
            fallback={<z-alert tone="danger" heading="decode failed">{decodeError()}</z-alert>}
          >
            <z-progress is-indeterminate tone="primary" style="width: 100%"></z-progress>
            <z-text size="sm" color="muted">
              decoding first frame…
            </z-text>
          </Show>
        </div>
      </Show>

      <div class="overlay top-left" onPointerDown={(event) => event.stopPropagation()}>
        <div class="hud">
          <z-link size="sm" on:click={props.onReset}>
            ↺ start over
          </z-link>
        </div>
      </div>

      <div class="overlay top-right" onPointerDown={(event) => event.stopPropagation()}>
        <button
          type="button"
          class="hud-button"
          aria-label={`Rotate frame view, currently ${viewRotation()} degrees`}
          title={`Rotate view (${viewRotation()} degrees)`}
          onClick={rotateView}
        >
          <span aria-hidden="true">↻</span>
          <span>{viewRotation()}°</span>
        </button>
      </div>

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
            frame {(index() + 1).toLocaleString()} / {frameCount().toLocaleString()}
          </z-text>
          <Show when={decodeError()}>
            <z-badge tone="danger" size="sm" label="decode error"></z-badge>
          </Show>
        </div>
        <For each={saveToasts()}>
          {(entry) => (
            <div class="hud">
              <z-text size="sm">{getSaveToastLabel(entry)}</z-text>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
