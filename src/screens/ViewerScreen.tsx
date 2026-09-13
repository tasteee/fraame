import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js'
import type { FrameSourceT } from '../lib/frameSource'
import { extractFullResFrame, getScrubSize, type VideoInfoT } from '../lib/video'
import { createVideoPreview, type VideoPreviewT } from '../lib/videoPreview'
import type { InputVideoTrack } from 'mediabunny'

type PropsT = {
  file: File
  track: InputVideoTrack
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

// Lets scrubbing a long video skip straight to the part you want instead of
// dragging through every frame in between.
const SMALL_JUMP_SEC = 5
const LARGE_JUMP_SEC = 20

// Mid-drag the index changes on every pointer event. Waiting for it to settle
// keeps a fast scrub from queueing a decode for frames nobody will look at.
const DECODE_SETTLE_MS = 55

// Painting a decoded neighbour is what makes a fast scrub read as slightly
// soft rather than stalled, but only while the neighbour is actually nearby.
// Past this distance it is a frame from somewhere else in the video, and
// showing it silently is worse than admitting we're still seeking.
const MAX_STALE_FRAME_DISTANCE = 45

type PaintSourceT = {
  image: CanvasImageSource
  width: number
  height: number
}

type ViewRotationT = (typeof VIEW_ROTATIONS)[number]

// What the canvas is currently showing. Only a stale neighbour is dimmed:
// the native preview is the right moment in the video and reads as final
// enough to leave at full strength, where dimming it for the whole drag
// would make every scrub look broken.
type PaintKindT = 'exact' | 'preview' | 'stale'

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
  const [isSeeking, setIsSeeking] = createSignal(false)
  const [paintKind, setPaintKind] = createSignal<PaintKindT>('stale')
  const [decodeError, setDecodeError] = createSignal<string | null>(null)
  let rootRef: HTMLDivElement | undefined
  let canvasRef: HTMLCanvasElement | undefined

  const frameCount = () => props.source.frameCount
  const clampIndex = (i: number) => Math.max(0, Math.min(frameCount() - 1, i))

  // ---- painting ----

  const applyViewRotation = (ctx: CanvasRenderingContext2D, rotation: ViewRotationT, width: number, height: number) => {
    if (rotation === 90) {
      ctx.translate(width, 0)
      ctx.rotate(Math.PI / 2)
      return
    }
    if (rotation === 180) {
      ctx.translate(width, height)
      ctx.rotate(Math.PI)
      return
    }
    if (rotation === 270) {
      ctx.translate(0, height)
      ctx.rotate(-Math.PI / 2)
    }
  }

  const paint = (source: PaintSourceT, rotation: ViewRotationT) => {
    if (!canvasRef) return
    const isSideways = rotation === 90 || rotation === 270
    const canvasWidth = isSideways ? source.height : source.width
    const canvasHeight = isSideways ? source.width : source.height
    if (canvasRef.width !== canvasWidth) canvasRef.width = canvasWidth
    if (canvasRef.height !== canvasHeight) canvasRef.height = canvasHeight

    const ctx = canvasRef.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, canvasRef.width, canvasRef.height)
    ctx.save()
    applyViewRotation(ctx, rotation, canvasRef.width, canvasRef.height)
    ctx.drawImage(source.image, 0, 0, source.width, source.height)
    ctx.restore()
    setHasPainted(true)
  }

  const paintBitmap = (bitmap: ImageBitmap, rotation: ViewRotationT) => {
    paint({ image: bitmap, width: bitmap.width, height: bitmap.height }, rotation)
  }

  // Draws the best frame already in memory. During a fast scrub that is a
  // near neighbour rather than the exact frame, which reads as a slightly
  // soft scrub instead of a stalled one.
  const paintBestAvailable = (i: number, rotation: ViewRotationT) => {
    const exact = props.source.getCached(i)
    if (exact) {
      paintBitmap(exact, rotation)
      setPaintKind('exact')
      return true
    }

    const nearby = props.source.getNearestCached(i, MAX_STALE_FRAME_DISTANCE)
    if (!nearby) return false

    paintBitmap(nearby, rotation)
    setPaintKind('stale')
    return false
  }

  // ---- native preview ----

  // The browser's own decoder answers a seek far sooner than a cold GOP walk
  // through WebCodecs, so it carries the picture while a drag is in flight.
  // It is never the authority on which frame is which — currentTime is a
  // time, not an index — so the exact frame paints over it on arrival.
  let preview: VideoPreviewT | null = null

  const halfFrameSec = () => 0.5 / props.info.fps

  // Fitted to the same box the decoded frames use, so handing off between the
  // two sources doesn't resize the canvas. Measured off the element rather
  // than off info, because the browser has already applied the container's
  // rotation to what it will hand us.
  const getPreviewDrawSize = (element: HTMLVideoElement) => {
    const scrubSize = getScrubSize(props.info)
    const boxMaxDim = Math.max(scrubSize.outW, scrubSize.outH)
    const naturalMaxDim = Math.max(element.videoWidth, element.videoHeight)
    const scale = Math.min(1, boxMaxDim / naturalMaxDim)

    return {
      width: Math.max(2, Math.round(element.videoWidth * scale)),
      height: Math.max(2, Math.round(element.videoHeight * scale)),
    }
  }

  const paintPreview = (rotation: ViewRotationT) => {
    if (!preview) return
    const element = preview.element
    const drawSize = getPreviewDrawSize(element)
    paint({ image: element, width: drawSize.width, height: drawSize.height }, rotation)
    setPaintKind('preview')
  }

  // The preview may already be sitting on the requested time — after a view
  // rotation, or when the neighbour cache missed but the video never moved.
  // Repainting it costs nothing and beats waiting on a seek that the
  // controller will correctly decline to issue.
  const paintPreviewIfCurrent = (timeSec: number, rotation: ViewRotationT) => {
    const isUsable = preview?.isUsable() ?? false
    if (!isUsable || !preview) return

    const isShowingTime = Math.abs(preview.element.currentTime - timeSec) < halfFrameSec()
    if (!isShowingTime) return
    paintPreview(rotation)
  }

  const handlePreviewPresented = () => {
    // An exact frame for this index outranks anything the preview holds.
    const hasExactFrame = props.source.getCached(index()) !== null
    if (hasExactFrame) return
    paintPreview(viewRotation())
  }

  onMount(() => {
    preview = createVideoPreview({
      file: props.file,
      info: props.info,
      onPresented: handlePreviewPresented,
    })

    preview.seekTo(0)
  })

  onCleanup(() => {
    preview?.destroy()
    preview = null
  })

  // ---- exact frames ----

  let settleTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    if (settleTimer) clearTimeout(settleTimer)
  })

  const resolveExactFrame = async (i: number) => {
    try {
      const bitmap = await props.source.requestFrame(i)
      const isStillCurrent = index() === i
      if (!isStillCurrent) return
      if (!bitmap) return

      paintBitmap(bitmap, viewRotation())
      setPaintKind('exact')
      setIsSeeking(false)
      setDecodeError(null)
    } catch {
      setIsSeeking(false)
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

    if (isExact) {
      setIsSeeking(false)
      return
    }

    setIsSeeking(true)

    const targetTimeSec = props.source.getTimeSec(i)
    paintPreviewIfCurrent(targetTimeSec, rotation)
    preview?.seekTo(targetTimeSec)
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

  const jumpBySec = (deltaSec: number) => {
    setIndex(clampIndex(index() + Math.round(deltaSec * props.info.fps)))
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
      const blob = await extractFullResFrame(props.track, props.info, timeSec, viewRotation())
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
      <canvas
        ref={canvasRef}
        class="frame-canvas"
        classList={{ 'is-hidden': !hasPainted(), 'is-provisional': paintKind() === 'stale' }}
      />

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

      <div class="overlay left-center" onPointerDown={(event) => event.stopPropagation()}>
        <div class="jump-buttons">
          <button
            type="button"
            class="hud-button hud-icon-button"
            aria-label={`Jump back ${LARGE_JUMP_SEC} seconds`}
            title={`Back ${LARGE_JUMP_SEC}s`}
            onClick={() => jumpBySec(-LARGE_JUMP_SEC)}
          >
            <span aria-hidden="true">⏪</span>
          </button>
          <button
            type="button"
            class="hud-button hud-icon-button"
            aria-label={`Jump back ${SMALL_JUMP_SEC} seconds`}
            title={`Back ${SMALL_JUMP_SEC}s`}
            onClick={() => jumpBySec(-SMALL_JUMP_SEC)}
          >
            <span aria-hidden="true">◀</span>
          </button>
          <button
            type="button"
            class="hud-button hud-icon-button"
            aria-label={`Jump forward ${SMALL_JUMP_SEC} seconds`}
            title={`Forward ${SMALL_JUMP_SEC}s`}
            onClick={() => jumpBySec(SMALL_JUMP_SEC)}
          >
            <span aria-hidden="true">▶</span>
          </button>
          <button
            type="button"
            class="hud-button hud-icon-button"
            aria-label={`Jump forward ${LARGE_JUMP_SEC} seconds`}
            title={`Forward ${LARGE_JUMP_SEC}s`}
            onClick={() => jumpBySec(LARGE_JUMP_SEC)}
          >
            <span aria-hidden="true">⏩</span>
          </button>
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
          <Show when={isSeeking() && !decodeError()}>
            <span class="seeking-marker" aria-live="polite">
              <span class="seeking-dot" aria-hidden="true" />
              <z-text size="sm" color="muted">
                seeking…
              </z-text>
            </span>
          </Show>
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
