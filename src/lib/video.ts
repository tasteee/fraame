import { WebDemuxer } from 'web-demuxer'

export const wasmLoaderPath = new URL('/wasm-files/ffmpeg.js', globalThis.location.href).href

export type VideoInfoT = {
  fileName: string
  width: number
  height: number
  rotation: number
  fps: number
  durationSec: number
  codecName: string
}

export type ProbeResultT = {
  demuxer: WebDemuxer
  info: VideoInfoT
}

const parseRational = (value: string | undefined): number => {
  if (!value) return 0
  const [num, den] = value.split('/').map(Number)
  if (den === undefined) return Number(value) || 0
  if (!num || !den) return 0
  return num / den
}

export const normalizeRotation = (value: number): number => {
  const r = Math.round(value / 90) * 90
  return ((r % 360) + 360) % 360
}

// Total frames the file is expected to hold. Derived from fps and duration
// rather than counted, so the viewer knows its range the moment the probe
// finishes instead of after a full decode pass.
export const getFrameCount = (info: VideoInfoT): number => {
  return Math.max(1, Math.floor(info.durationSec * info.fps))
}

export async function probeVideo(file: File): Promise<ProbeResultT> {
  const demuxer = new WebDemuxer({ wasmLoaderPath })
  try {
    await demuxer.load(file)
    const stream = await demuxer.getVideoStream()
    if (!stream || !stream.width) throw new Error('No video stream found in this file.')

    const mediaInfo = await demuxer.getMediaInfo()
    const fps = parseRational(stream.avg_frame_rate) || parseRational(stream.r_frame_rate)
    const durationSec = stream.duration > 0 ? stream.duration : mediaInfo.duration

    if (!fps || !durationSec) throw new Error('Could not read the frame rate or duration of this video.')

    // Checked here rather than at first decode so an unsupported codec is
    // reported while the user is still on the upload screen.
    const config = await demuxer.getVideoDecoderConfig()
    const support = await VideoDecoder.isConfigSupported(config).catch(() => null)
    if (!support?.supported) {
      throw new Error(`This browser can't decode ${stream.codec_name || 'this'} video.`)
    }

    return {
      demuxer,
      info: {
        fileName: file.name,
        width: stream.width,
        height: stream.height,
        rotation: normalizeRotation(stream.rotation ?? 0),
        fps,
        durationSec,
        codecName: stream.codec_name,
      },
    }
  } catch (error) {
    demuxer.destroy()
    throw error
  }
}

export type RotationDrawTargetT = {
  ctx: OffscreenCanvasRenderingContext2D
  rotation: number
  outW: number
  outH: number
}

export const drawRotated = (target: RotationDrawTargetT, source: CanvasImageSource) => {
  const { ctx, rotation, outW, outH } = target
  const swapped = rotation === 90 || rotation === 270
  const dw = swapped ? outH : outW
  const dh = swapped ? outW : outH
  ctx.save()
  if (rotation === 90) {
    ctx.translate(outW, 0)
    ctx.rotate(Math.PI / 2)
  } else if (rotation === 180) {
    ctx.translate(outW, outH)
    ctx.rotate(Math.PI)
  } else if (rotation === 270) {
    ctx.translate(0, outH)
    ctx.rotate(-Math.PI / 2)
  }
  ctx.drawImage(source, 0, 0, dw, dh)
  ctx.restore()
}

// Scrub proxies only have to look right on screen; the download path always
// re-decodes at full resolution. Keeping the proxy well under display size is
// what lets a useful number of frames fit in the cache at once, and smaller
// frames also make each transferToImageBitmap noticeably cheaper on phones.
const SCRUB_MAX_DIM = 960

// Both scrub paths — decoded frames and the native preview — paint at this
// size, so handing off between them never resizes the canvas.
export const getScrubSize = (info: VideoInfoT) => {
  const devicePixels = Math.max(window.innerWidth, window.innerHeight) * (window.devicePixelRatio || 1)
  const deviceMaxDim = Math.round(devicePixels)
  const scrubMaxDim = Math.min(SCRUB_MAX_DIM, deviceMaxDim)
  return displaySize(info, scrubMaxDim)
}

export const displaySize = (info: VideoInfoT, maxDim: number) => {
  const swapped = info.rotation === 90 || info.rotation === 270
  const naturalW = swapped ? info.height : info.width
  const naturalH = swapped ? info.width : info.height
  const scale = Math.min(1, maxDim / Math.max(naturalW, naturalH))
  return {
    outW: Math.max(2, Math.round(naturalW * scale)),
    outH: Math.max(2, Math.round(naturalH * scale)),
  }
}

type FullResDemuxerCacheT = {
  file: File
  demuxer: WebDemuxer
  baseUs: number
}

// Spinning up a WebDemuxer means starting a dedicated Worker and compiling
// the ~4MB ffmpeg WASM module from scratch, so this is kept alive and reused
// across every full-res download for the same file. It stays separate from
// the scrubbing demuxer because a single demuxer can only serve one packet
// reader at a time.
let fullResCache: FullResDemuxerCacheT | null = null

const createFullResDemuxer = async (file: File): Promise<FullResDemuxerCacheT> => {
  const demuxer = new WebDemuxer({ wasmLoaderPath })
  try {
    await demuxer.load(file)
    const basePacket = await demuxer.seekVideoPacket(0)
    const baseUs = basePacket.timestamp * 1e6
    return { file, demuxer, baseUs }
  } catch (error) {
    demuxer.destroy()
    throw error
  }
}

const getFullResDemuxer = async (file: File): Promise<FullResDemuxerCacheT> => {
  const isCachedForThisFile = fullResCache !== null && fullResCache.file === file
  if (isCachedForThisFile) return fullResCache as FullResDemuxerCacheT

  fullResCache?.demuxer.destroy()
  fullResCache = await createFullResDemuxer(file)
  return fullResCache
}

// Releases the cached full-res demuxer. Call this when the viewer for a file
// is torn down so its worker doesn't linger in the background.
export const releaseFullResDemuxer = (): void => {
  fullResCache?.demuxer.destroy()
  fullResCache = null
}

// Re-decodes a single frame from the original file at full resolution and
// returns it as a PNG. Reuses a cached demuxer instance (see above) so it
// doesn't pay for a fresh WASM instance on every call.
export const extractFullResFrame = async (
  file: File,
  info: VideoInfoT,
  timeSec: number,
  viewRotation = 0,
): Promise<Blob> => {
  const cached = await getFullResDemuxer(file)
  const demuxer = cached.demuxer
  let best: VideoFrame | null = null
  try {
    const config = await demuxer.getVideoDecoderConfig()
    const targetUs = cached.baseUs + timeSec * 1e6
    const halfFrameUs = 0.5e6 / info.fps

    let pipelineError: Error | null = null
    const decoder = new VideoDecoder({
      output: (frame) => {
        const distance = Math.abs(frame.timestamp - targetUs)
        if (best === null || distance < Math.abs(best.timestamp - targetUs)) {
          best?.close()
          best = frame
        } else {
          frame.close()
        }
      },
      error: (error) => {
        pipelineError = error as Error
      },
    })
    decoder.configure({ ...config, hardwareAcceleration: 'prefer-hardware' })

    const seekSec = Math.max(0, cached.baseUs / 1e6 + timeSec)
    const reader = demuxer.readVideoPacket(seekSec).getReader()
    try {
      while (!pipelineError) {
        const { done, value } = await reader.read()
        if (done) break
        decoder.decode(demuxer.genEncodedVideoChunk(value))
        // Packets arrive in decode order; once we're comfortably past the
        // target in presentation time, everything needed has been queued.
        if (value.timestamp * 1e6 > targetUs + halfFrameUs + 0.5e6) break
        if (decoder.decodeQueueSize > 24) {
          await new Promise((resolve) => setTimeout(resolve, 8))
        }
      }
      if (!pipelineError) await decoder.flush()
    } finally {
      reader.cancel().catch(() => {})
      try {
        decoder.close()
      } catch {
        // already closed by an error
      }
    }

    if (pipelineError) throw pipelineError
    if (!best) throw new Error('No frame decoded at that time.')

    const rotation = normalizeRotation(info.rotation + viewRotation)
    const swapped = rotation === 90 || rotation === 270
    const outW = swapped ? info.height : info.width
    const outH = swapped ? info.width : info.height
    const canvas = new OffscreenCanvas(outW, outH)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not create a canvas context.')
    drawRotated({ ctx, rotation, outW, outH }, best)
    return await canvas.convertToBlob({ type: 'image/png' })
  } finally {
    ;(best as VideoFrame | null)?.close()
  }
}
