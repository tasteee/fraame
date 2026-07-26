import type { WebDemuxer } from 'web-demuxer'
import { displaySize, drawRotated, getFrameCount, type RotationDrawTargetT, type VideoInfoT } from './video'

// Scrub proxies only have to look right on screen; the download path always
// re-decodes at full resolution. Keeping the proxy well under display size is
// what lets a useful number of frames fit in the cache at once.
const SCRUB_MAX_DIM = 1440

// ImageBitmaps are GPU-backed and large, so the cache is bounded by total
// pixels rather than by frame count.
const MAX_CACHED_PIXELS = 64_000_000

// Frames kept on either side of a request when its GOP is decoded. Everything
// outside this window is closed as soon as it comes out of the decoder.
const RETAIN_BEHIND = 16
const RETAIN_AHEAD = 24

// Seeking lands on the keyframe at or before this point, so nudging back by a
// hair keeps a request that sits exactly on a keyframe from overshooting.
const SEEK_EPSILON_SEC = 0.001

export type FrameSourceParamsT = {
  demuxer: WebDemuxer
  info: VideoInfoT
}

export type FrameSourceT = {
  frameCount: number
  getCached: (index: number) => ImageBitmap | null
  getNearestCached: (index: number) => ImageBitmap | null
  requestFrame: (index: number) => Promise<ImageBitmap | null>
  getTimeSec: (index: number) => number
  destroy: () => void
}

export const createFrameSource = (params: FrameSourceParamsT): FrameSourceT => {
  const demuxer = params.demuxer
  const info = params.info
  const frameCount = getFrameCount(info)

  const deviceMaxDim = Math.round(Math.max(window.innerWidth, window.innerHeight) * (window.devicePixelRatio || 1))
  const scrubMaxDim = Math.min(SCRUB_MAX_DIM, deviceMaxDim)
  const size = displaySize(info, scrubMaxDim)
  const pixelsPerFrame = size.outW * size.outH

  const canvas = new OffscreenCanvas(size.outW, size.outH)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not create a canvas context.')
  const drawTarget: RotationDrawTargetT = { ctx, rotation: info.rotation, outW: size.outW, outH: size.outH }

  const cache = new Map<number, ImageBitmap>()
  let cachedPixels = 0
  let lastRequestedIndex = 0
  let isDestroyed = false

  const getTimeSec = (index: number): number => index / info.fps

  const toFrameIndex = (timestampUs: number, baseUs: number): number => {
    return Math.round(((timestampUs - baseUs) / 1e6) * info.fps)
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
    while (cachedPixels > MAX_CACHED_PIXELS && cache.size > 1) {
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
    }
  }

  const putCached = (index: number, bitmap: ImageBitmap) => {
    dropCached(index)
    cache.set(index, bitmap)
    cachedPixels += pixelsPerFrame
    evictToBudget()
  }

  const getCached = (index: number): ImageBitmap | null => cache.get(index) ?? null

  const getNearestCached = (index: number): ImageBitmap | null => {
    let nearestBitmap: ImageBitmap | null = null
    let nearestDistance = Number.POSITIVE_INFINITY

    for (const [cachedIndex, bitmap] of cache) {
      const distance = Math.abs(cachedIndex - index)
      if (distance >= nearestDistance) continue
      nearestDistance = distance
      nearestBitmap = bitmap
    }

    return nearestBitmap
  }

  // ---- decode ----

  let baseUsPromise: Promise<number> | null = null

  const getBaseUs = (): Promise<number> => {
    if (baseUsPromise) return baseUsPromise
    baseUsPromise = demuxer.seekVideoPacket(0).then((packet) => packet.timestamp * 1e6)
    return baseUsPromise
  }

  let queuedIndex: number | null = null
  let runningPump: Promise<void> | null = null

  const captureFrame = (frame: VideoFrame, index: number) => {
    drawRotated(drawTarget, frame)
    putCached(index, canvas.transferToImageBitmap())
  }

  // Seeks to the keyframe at or before the requested frame and decodes forward
  // through it, keeping a window of neighbours on the way past. Cost is
  // proportional to distance from the keyframe, not to video length.
  const decodeAround = async (requestIndex: number) => {
    const baseUs = await getBaseUs()
    if (isDestroyed) return

    const config = await demuxer.getVideoDecoderConfig()
    if (isDestroyed) return

    const firstWanted = requestIndex - RETAIN_BEHIND
    const lastWanted = requestIndex + RETAIN_AHEAD
    const stopUs = baseUs + getTimeSec(lastWanted + 2) * 1e6

    let pipelineError: Error | null = null
    const decoder = new VideoDecoder({
      output: (frame) => {
        const frameIndex = toFrameIndex(frame.timestamp, baseUs)
        const isWanted = frameIndex >= firstWanted && frameIndex <= lastWanted
        if (isWanted && !cache.has(frameIndex) && !isDestroyed) captureFrame(frame, frameIndex)
        frame.close()
      },
      error: (error) => {
        pipelineError = error as Error
      },
    })

    // optimizeForLatency keeps the decoder from buffering ahead, which is what
    // we want when every decode starts from a fresh seek.
    decoder.configure({ ...config, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true })

    const seekSec = Math.max(0, baseUs / 1e6 + getTimeSec(requestIndex) - SEEK_EPSILON_SEC)
    const reader = demuxer.readVideoPacket(seekSec).getReader()
    try {
      while (!pipelineError && !isDestroyed) {
        // A newer request landed while this one was still decoding, so the
        // frames still to come are already stale.
        if (queuedIndex !== null) break

        const { done, value } = await reader.read()
        if (done) break
        decoder.decode(demuxer.genEncodedVideoChunk(value))
        if (value.timestamp * 1e6 > stopUs) break
        if (decoder.decodeQueueSize > 24) {
          await new Promise((resolve) => setTimeout(resolve, 8))
        }
      }
      if (!pipelineError && !isDestroyed) await decoder.flush()
    } finally {
      reader.cancel().catch(() => {})
      try {
        decoder.close()
      } catch {
        // already closed by an error
      }
    }

    if (pipelineError) throw pipelineError
  }

  // Single-flight: only one decode runs against the demuxer at a time, and a
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

  const requestFrame = async (index: number): Promise<ImageBitmap | null> => {
    if (isDestroyed) return null
    lastRequestedIndex = index

    const cached = cache.get(index)
    if (cached) return cached

    queuedIndex = index
    await pump()
    return cache.get(index) ?? null
  }

  const destroy = () => {
    isDestroyed = true
    queuedIndex = null
    for (const bitmap of cache.values()) bitmap.close()
    cache.clear()
    cachedPixels = 0
    demuxer.destroy()
  }

  return { frameCount, getCached, getNearestCached, requestFrame, getTimeSec, destroy }
}
