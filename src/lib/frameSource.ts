import { VideoSampleSink, type InputVideoTrack, type VideoSample } from 'mediabunny'
import { getAbsoluteTimeSec, getFrameCount, getScrubSize, type VideoInfoT } from './video'

// ImageBitmaps are GPU-backed and large, so the cache is bounded by total
// pixels rather than by frame count.
const MAX_CACHED_PIXELS = 64_000_000

// How far past the requested frame to keep pulling samples. Everything decoded
// on the way there is kept: reaching the requested frame already required
// decoding its whole GOP, so discarding those frames only guarantees paying
// for them again on the next small nudge.
const DECODE_AHEAD = 24

// How far ahead of an open iterator a request can sit and still be served by
// pulling forward through it. Beyond this, restarting on a nearer keyframe
// decodes less than walking there would.
//
// It is set well above DECODE_AHEAD deliberately. A restart costs a whole new
// VideoDecoder — mediabunny builds one per iterator and closes it at the end —
// and on Android that configure() is the 200-600ms MediaCodec spin-up that
// makes scrubbing feel broken. Walking a couple of hundred frames forward
// through a decoder that already exists is the cheaper mistake.
const MAX_FORWARD_PULL = 180

export type FrameSourceParamsT = {
  track: InputVideoTrack
  info: VideoInfoT
}

export type FrameSourceT = {
  frameCount: number
  getCached: (index: number) => ImageBitmap | null
  getNearestCached: (index: number, maxDistance: number) => ImageBitmap | null
  requestFrame: (index: number) => Promise<ImageBitmap | null>
  getTimeSec: (index: number) => number
  destroy: () => void
}

// A suspended run of samples, held open between requests. Keeping it alive is
// the whole point: a scrub that moves forward reuses one decoder for its
// entire length instead of building one per settle.
type DecodeWindowT = {
  samples: AsyncGenerator<VideoSample, void, unknown>
  lastYieldedIndex: number
  isExhausted: boolean
}

export const createFrameSource = (params: FrameSourceParamsT): FrameSourceT => {
  const track = params.track
  const info = params.info
  const frameCount = getFrameCount(info)

  const size = getScrubSize(info)
  const pixelsPerFrame = size.outW * size.outH

  const canvas = new OffscreenCanvas(size.outW, size.outH)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not create a canvas context.')

  // optimizeForLatency keeps the decoder from buffering ahead, which is what
  // we want when a scrub cares about the frame it just asked for rather than
  // sustained throughput.
  const sampleSink = new VideoSampleSink(track, {
    hardwareAcceleration: 'prefer-hardware',
    optimizeForLatency: true,
  })

  const cache = new Map<number, ImageBitmap>()
  let cachedPixels = 0
  let lastRequestedIndex = 0
  let isDestroyed = false

  const getTimeSec = (index: number): number => index / info.fps

  const toFrameIndex = (timestampSec: number): number => {
    return Math.round((timestampSec - info.firstTimestampSec) * info.fps)
  }

  // ---- cache ----

  const dropCached = (index: number) => {
    const bitmap = cache.get(index)
    if (!bitmap) return
    bitmap.close()
    cache.delete(index)
    cachedPixels -= pixelsPerFrame
  }

  // Evicts whatever sits farthest from the playhead, so the frames a scrub is
  // most likely to revisit are the last to go.
  const evictToBudget = () => {
    const isOverBudget = cachedPixels > MAX_CACHED_PIXELS && cache.size > 1
    if (!isOverBudget) return

    let farthestIndex = -1
    let farthestDistance = -1

    for (const index of cache.keys()) {
      const distance = Math.abs(index - lastRequestedIndex)
      if (distance <= farthestDistance) continue
      farthestDistance = distance
      farthestIndex = index
    }

    if (farthestIndex < 0) return
    dropCached(farthestIndex)
    evictToBudget()
  }

  const putCached = (index: number, bitmap: ImageBitmap) => {
    dropCached(index)
    cache.set(index, bitmap)
    cachedPixels += pixelsPerFrame
    evictToBudget()
  }

  const getCached = (index: number): ImageBitmap | null => cache.get(index) ?? null

  // Bounded by distance on purpose. An unbounded nearest match will happily
  // return a frame from a completely different part of the video during a long
  // scrub, which paints as a confident, wrong image with no sign anything is
  // still loading.
  const getNearestCached = (index: number, maxDistance: number): ImageBitmap | null => {
    let nearestBitmap: ImageBitmap | null = null
    let nearestDistance = maxDistance + 1

    for (const [cachedIndex, bitmap] of cache) {
      const distance = Math.abs(cachedIndex - index)
      if (distance >= nearestDistance) continue
      nearestDistance = distance
      nearestBitmap = bitmap
    }

    return nearestBitmap
  }

  // ---- arrival waiters ----

  // The frame a caller asked for is usually decoded long before the read-ahead
  // window finishes. These let requestFrame settle the moment its own frame
  // lands, while the read-ahead keeps filling the cache behind it.
  type FrameWaiterT = {
    arrival: Promise<ImageBitmap>
    dispose: () => void
  }

  const frameWaiters = new Map<number, Set<(bitmap: ImageBitmap) => void>>()

  const notifyFrameWaiters = (index: number, bitmap: ImageBitmap) => {
    const waiters = frameWaiters.get(index)
    if (!waiters) return

    frameWaiters.delete(index)
    for (const resolve of waiters) resolve(bitmap)
  }

  const createFrameWaiter = (index: number): FrameWaiterT => {
    let resolveArrival: (bitmap: ImageBitmap) => void = () => {}

    const arrival = new Promise<ImageBitmap>((resolve) => {
      resolveArrival = resolve
    })

    const existing = frameWaiters.get(index)
    if (existing) existing.add(resolveArrival)
    if (!existing) frameWaiters.set(index, new Set([resolveArrival]))

    const dispose = () => {
      const waiters = frameWaiters.get(index)
      if (!waiters) return

      waiters.delete(resolveArrival)
      if (waiters.size === 0) frameWaiters.delete(index)
    }

    return { arrival, dispose }
  }

  // ---- decode ----

  let queuedIndex: number | null = null
  let runningPump: Promise<void> | null = null
  let openWindow: DecodeWindowT | null = null

  const captureFrame = (sample: VideoSample, index: number) => {
    // The sample carries the container's rotation, so this lands upright
    // without any transform of ours; 'fill' is exact because the canvas was
    // sized from the same display dimensions.
    sample.drawWithFit(ctx, { fit: 'fill' })
    putCached(index, canvas.transferToImageBitmap())
  }

  const closeWindow = async () => {
    if (!openWindow) return

    const closing = openWindow
    openWindow = null
    await closing.samples.return()
  }

  // A window can serve a request only by moving forward through it. Anything
  // behind its last frame, or too far ahead of it, needs a fresh seek.
  const getContinuableWindow = (requestIndex: number): DecodeWindowT | null => {
    const window = openWindow
    if (!window || window.isExhausted) return null

    const distanceAhead = requestIndex - window.lastYieldedIndex
    const isReachable = distanceAhead >= 0 && distanceAhead <= MAX_FORWARD_PULL
    if (!isReachable) return null
    return window
  }

  const openWindowAt = async (requestIndex: number): Promise<DecodeWindowT> => {
    await closeWindow()

    const startSec = getAbsoluteTimeSec(info, requestIndex)
    const window: DecodeWindowT = {
      samples: sampleSink.samples(startSec),
      lastYieldedIndex: requestIndex - 1,
      isExhausted: false,
    }

    openWindow = window
    return window
  }

  const consumeSample = (window: DecodeWindowT, sample: VideoSample) => {
    const frameIndex = toFrameIndex(sample.timestamp)
    window.lastYieldedIndex = frameIndex

    const shouldCapture = !cache.has(frameIndex) && !isDestroyed
    if (shouldCapture) captureFrame(sample, frameIndex)
    sample.close()

    // Read back rather than trusting the capture: putCached runs eviction, so
    // in a pathological case the bitmap just added may already be gone.
    const stored = cache.get(frameIndex)
    if (stored) notifyFrameWaiters(frameIndex, stored)
  }

  // Pulls one sample at a time so the generator stays suspended rather than
  // closed when we stop early. A `for await...of` loop would call return() on
  // break and take the decoder down with it, which is exactly what this
  // window exists to avoid.
  const pullThrough = async (window: DecodeWindowT, stopIndex: number): Promise<void> => {
    if (isDestroyed) return

    // A newer request landed. Leave the generator suspended — the next
    // request is usually just ahead of here and can carry straight on.
    if (queuedIndex !== null) return

    const result = await window.samples.next()
    if (result.done) {
      window.isExhausted = true
      return
    }

    consumeSample(window, result.value)
    if (window.lastYieldedIndex >= stopIndex) return
    await pullThrough(window, stopIndex)
  }

  const decodeAround = async (requestIndex: number) => {
    const continuable = getContinuableWindow(requestIndex)
    const window = continuable === null ? await openWindowAt(requestIndex) : continuable
    if (isDestroyed) return

    await pullThrough(window, requestIndex + DECODE_AHEAD)
  }

  // Single-flight: only one decode runs against the track at a time, and a
  // request that arrives mid-decode replaces any other request waiting behind
  // it rather than queueing up behind a scrub the user already moved past.
  const pump = (): Promise<void> => {
    if (runningPump) return runningPump

    runningPump = (async () => {
      try {
        while (queuedIndex !== null && !isDestroyed) {
          const index = queuedIndex
          queuedIndex = null
          if (cache.has(index)) continue
          await decodeAround(index)
        }
      } finally {
        runningPump = null
      }
    })()

    return runningPump
  }

  // A pump already on its final tick when a request arrives can settle without
  // ever seeing it, which would strand the caller on a frame that never
  // decoded. Chaining a fresh pump behind the running one closes that gap.
  const pumpUntilIdle = async (): Promise<void> => {
    await pump()
    if (queuedIndex === null) return
    await pumpUntilIdle()
  }

  const requestFrame = async (index: number): Promise<ImageBitmap | null> => {
    if (isDestroyed) return null
    lastRequestedIndex = index

    const cached = cache.get(index)
    if (cached) return cached

    queuedIndex = index

    const waiter = createFrameWaiter(index)

    // The second branch covers everything arrival can't: a frame index past
    // the end of the stream, a timestamp that rounds to a neighbour, a decode
    // that fails. Race rejection is handled by the race itself, so a pump
    // failure that loses to an arrival can't surface as an unhandled one.
    const drained = pumpUntilIdle().then(() => cache.get(index) ?? null)

    try {
      return await Promise.race([waiter.arrival, drained])
    } finally {
      waiter.dispose()
    }
  }

  const destroy = () => {
    isDestroyed = true
    queuedIndex = null
    frameWaiters.clear()
    void closeWindow()
    for (const bitmap of cache.values()) bitmap.close()
    cache.clear()
    cachedPixels = 0
  }

  return { frameCount, getCached, getNearestCached, requestFrame, getTimeSec, destroy }
}
