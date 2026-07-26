import type { WebDemuxer } from 'web-demuxer'
import { displaySize, drawRotated, getFrameCount, type RotationDrawTargetT, type VideoInfoT } from './video'

// Scrub proxies only have to look right on screen; the download path always
// re-decodes at full resolution. Keeping the proxy well under display size is
// what lets a useful number of frames fit in the cache at once, and smaller
// frames also make each transferToImageBitmap noticeably cheaper on phones.
const SCRUB_MAX_DIM = 960

// ImageBitmaps are GPU-backed and large, so the cache is bounded by total
// pixels rather than by frame count.
const MAX_CACHED_PIXELS = 64_000_000

// How far past the requested frame to keep pulling packets. Everything decoded
// on the way there is kept: reaching the requested frame already required
// decoding its whole GOP, so discarding those frames only guarantees paying
// for them again on the next small nudge.
const DECODE_AHEAD = 48

// Seeking lands on the keyframe at or before this point, so nudging back by a
// hair keeps a request that sits exactly on a keyframe from overshooting.
const SEEK_EPSILON_SEC = 0.001

// Ceiling on packets fed between decodeQueueSize checks, so a pathological
// stream can't run the queue away from us.
const MAX_QUEUE_DEPTH = 24

const waitMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export type FrameSourceParamsT = {
  demuxer: WebDemuxer
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

  // ---- demuxer probes ----

  let baseUsPromise: Promise<number> | null = null

  const getBaseUs = (): Promise<number> => {
    if (baseUsPromise) return baseUsPromise
    baseUsPromise = demuxer.seekVideoPacket(0).then((packet) => packet.timestamp * 1e6)
    return baseUsPromise
  }

  // Probing the container for a decoder config is a round trip to the demuxer
  // worker, and the answer never changes for a given file.
  let configPromise: Promise<VideoDecoderConfig> | null = null

  const getDecoderConfig = (): Promise<VideoDecoderConfig> => {
    if (configPromise) return configPromise
    configPromise = demuxer.getVideoDecoderConfig()
    return configPromise
  }

  let queuedIndex: number | null = null
  let runningPump: Promise<void> | null = null

  const captureFrame = (frame: VideoFrame, index: number) => {
    drawRotated(drawTarget, frame)
    putCached(index, canvas.transferToImageBitmap())
  }

  // ---- decoder lifetime ----

  // One decoder is kept alive for the whole session. Constructing and
  // configuring a VideoDecoder is nearly free on VideoToolbox, but on Android
  // configure() spins up a fresh MediaCodec instance and costs 200-600ms —
  // paid once per scrub if the decoder is rebuilt per request, which is what
  // made seeking feel broken on Android while iOS felt fine.
  //
  // Nothing is reset between seeks: every seek starts on a keyframe, and a
  // keyframe resynchronises a decoder on its own.
  let decoder: VideoDecoder | null = null
  let decoderError: Error | null = null
  let decodeBaseUs = 0

  const handleDecodedFrame = (frame: VideoFrame) => {
    const frameIndex = toFrameIndex(frame.timestamp, decodeBaseUs)
    const isAlreadyCached = cache.has(frameIndex)
    if (!isAlreadyCached && !isDestroyed) captureFrame(frame, frameIndex)
    frame.close()
  }

  const discardDecoder = () => {
    decoderError = null
    if (!decoder) return

    try {
      decoder.close()
    } catch {
      // already closed by the error that got us here
    }
    decoder = null
  }

  const getDecoder = async (): Promise<VideoDecoder> => {
    const isReusable = decoder !== null && decoder.state !== 'closed'
    if (isReusable) return decoder as VideoDecoder

    const config = await getDecoderConfig()

    const created = new VideoDecoder({
      output: handleDecodedFrame,
      error: (error) => {
        decoderError = error as Error
      },
    })

    // optimizeForLatency keeps the decoder from buffering ahead, which is what
    // we want when every decode starts from a fresh seek.
    created.configure({ ...config, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true })
    decoder = created
    return created
  }

  // ---- decode ----

  // Seeks to the keyframe at or before the requested frame and decodes forward
  // through it, keeping everything it produces. Cost is proportional to
  // distance from the keyframe, not to video length.
  const decodeAround = async (requestIndex: number) => {
    decodeBaseUs = await getBaseUs()
    if (isDestroyed) return

    const activeDecoder = await getDecoder()
    if (isDestroyed) return

    const stopUs = decodeBaseUs + getTimeSec(requestIndex + DECODE_AHEAD) * 1e6
    const seekSec = Math.max(0, decodeBaseUs / 1e6 + getTimeSec(requestIndex) - SEEK_EPSILON_SEC)
    const reader = demuxer.readVideoPacket(seekSec).getReader()

    try {
      while (!decoderError && !isDestroyed) {
        // A newer request landed while this one was still decoding. Stop
        // pulling packets, but let what is already queued drain — those frames
        // are valid and land in the cache either way.
        if (queuedIndex !== null) break

        const { done, value } = await reader.read()
        if (done) break

        activeDecoder.decode(demuxer.genEncodedVideoChunk(value))
        if (value.timestamp * 1e6 > stopUs) break

        const isQueueBacked = activeDecoder.decodeQueueSize > MAX_QUEUE_DEPTH
        if (isQueueBacked) await waitMs(8)
      }

      // Draining before returning keeps the next seek's packets from
      // interleaving with this one's inside a decoder we no longer rebuild.
      const canFlush = !decoderError && !isDestroyed && activeDecoder.state === 'configured'
      if (canFlush) await activeDecoder.flush()
    } finally {
      reader.cancel().catch(() => {})
    }

    if (!decoderError) return

    const failure = decoderError
    discardDecoder()
    throw failure
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
    discardDecoder()
    for (const bitmap of cache.values()) bitmap.close()
    cache.clear()
    cachedPixels = 0
    demuxer.destroy()
  }

  return { frameCount, getCached, getNearestCached, requestFrame, getTimeSec, destroy }
}
