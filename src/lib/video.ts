import { WebDemuxer } from 'web-demuxer'

const wasmLoaderPath = new URL('/wasm-files/ffmpeg.js', globalThis.location.href).href

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

export type FrameT = {
  blob: Blob
  timeSec: number
}

const parseRational = (value: string | undefined): number => {
  if (!value) return 0
  const [num, den] = value.split('/').map(Number)
  if (den === undefined) return Number(value) || 0
  if (!num || !den) return 0
  return num / den
}

const normalizeRotation = (value: number): number => {
  const r = Math.round(value / 90) * 90
  return ((r % 360) + 360) % 360
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

type RotationDrawTargetT = {
  ctx: OffscreenCanvasRenderingContext2D
  rotation: number
  outW: number
  outH: number
}

const drawRotated = (target: RotationDrawTargetT, source: CanvasImageSource) => {
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

const displaySize = (info: VideoInfoT, maxDim: number) => {
  const swapped = info.rotation === 90 || info.rotation === 270
  const naturalW = swapped ? info.height : info.width
  const naturalH = swapped ? info.width : info.height
  const scale = Math.min(1, maxDim / Math.max(naturalW, naturalH))
  return {
    outW: Math.max(2, Math.round(naturalW * scale)),
    outH: Math.max(2, Math.round(naturalH * scale)),
  }
}

export type ExtractParamsT = {
  demuxer: WebDemuxer
  info: VideoInfoT
  extractFps: number
  maxDim: number
  signal: AbortSignal
  onFrame: (frame: FrameT) => void
}

// Decodes every frame via WebCodecs (no <video> seeking, so nothing can be
// dropped or throttled), keeps only frames that cross the next target
// timestamp, downscales each kept frame to display size, and compresses it
// to a small blob. Backpressure caps how many raw VideoFrames are alive at
// once so GPU memory stays flat even on 4K sources.
export async function extractFrames(params: ExtractParamsT): Promise<void> {
  const { demuxer, info, extractFps, signal, onFrame } = params

  const config = await demuxer.getVideoDecoderConfig()
  const support = await VideoDecoder.isConfigSupported(config).catch(() => null)
  if (!support?.supported) {
    throw new Error(`This browser can't decode ${info.codecName || 'this'} video.`)
  }

  const { outW, outH } = displaySize(info, params.maxDim)
  const canvas = new OffscreenCanvas(outW, outH)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not create a canvas context.')
  const target: RotationDrawTargetT = { ctx, rotation: info.rotation, outW, outH }

  const stepUs = 1e6 / extractFps
  let firstTsUs: number | null = null
  let nextTargetUs = 0
  let mime = 'image/webp'

  const encodeQueue: VideoFrame[] = []
  let pumping = false
  let pipelineError: Error | null = null

  const pump = async () => {
    if (pumping) return
    pumping = true
    try {
      while (encodeQueue.length > 0) {
        const frame = encodeQueue.shift()!
        const timeSec = (frame.timestamp - firstTsUs!) / 1e6
        drawRotated(target, frame)
        frame.close()
        if (signal.aborted) return
        let blob = await canvas.convertToBlob({ type: mime, quality: 0.82 })
        if (mime === 'image/webp' && blob.type !== 'image/webp') {
          // Safari can't encode webp; it silently falls back. Use jpeg instead.
          mime = 'image/jpeg'
          blob = await canvas.convertToBlob({ type: mime, quality: 0.85 })
        }
        if (signal.aborted) return
        onFrame({ blob, timeSec })
      }
    } catch (error) {
      pipelineError = error as Error
    } finally {
      pumping = false
    }
  }

  const decoder = new VideoDecoder({
    output: (frame) => {
      if (signal.aborted || pipelineError) {
        frame.close()
        return
      }
      const ts = frame.timestamp
      if (firstTsUs === null) {
        firstTsUs = ts
        nextTargetUs = ts
      }
      if (ts >= nextTargetUs - 1) {
        do {
          nextTargetUs += stepUs
        } while (nextTargetUs <= ts + 1)
        encodeQueue.push(frame)
        void pump()
      } else {
        frame.close()
      }
    },
    error: (error) => {
      pipelineError = error as Error
    },
  })
  decoder.configure(config)

  const waitFor = (condition: () => boolean) =>
    new Promise<void>((resolve) => {
      const tick = () => {
        if (condition() || signal.aborted || pipelineError) resolve()
        else setTimeout(tick, 8)
      }
      tick()
    })

  const reader = demuxer.readVideoPacket().getReader()
  try {
    while (!signal.aborted && !pipelineError) {
      const { done, value } = await reader.read()
      if (done) break
      decoder.decode(demuxer.genEncodedVideoChunk(value))
      if (decoder.decodeQueueSize > 16 || encodeQueue.length > 4) {
        await waitFor(() => decoder.decodeQueueSize <= 8 && encodeQueue.length <= 2)
      }
    }
    if (!signal.aborted && !pipelineError) {
      await decoder.flush()
      await waitFor(() => encodeQueue.length === 0 && !pumping)
    }
  } finally {
    reader.cancel().catch(() => {})
    try {
      decoder.close()
    } catch {
      // already closed by an error
    }
    for (const frame of encodeQueue.splice(0)) frame.close()
  }

  if (pipelineError && !signal.aborted) throw pipelineError
}

// Re-decodes a single frame from the original file at full resolution and
// returns it as a PNG. Uses its own demuxer instance so it can run while the
// main extraction is still in progress.
export async function extractFullResFrame(file: File, info: VideoInfoT, timeSec: number): Promise<Blob> {
  const demuxer = new WebDemuxer({ wasmLoaderPath })
  let best: VideoFrame | null = null
  try {
    await demuxer.load(file)
    const config = await demuxer.getVideoDecoderConfig()

    const basePacket = await demuxer.seekVideoPacket(0)
    const baseUs = basePacket.timestamp * 1e6
    const targetUs = baseUs + timeSec * 1e6
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
    decoder.configure(config)

    const seekSec = Math.max(0, baseUs / 1e6 + timeSec)
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

    const swapped = info.rotation === 90 || info.rotation === 270
    const outW = swapped ? info.height : info.width
    const outH = swapped ? info.width : info.height
    const canvas = new OffscreenCanvas(outW, outH)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not create a canvas context.')
    drawRotated({ ctx, rotation: info.rotation, outW, outH }, best)
    return await canvas.convertToBlob({ type: 'image/png' })
  } finally {
    ;(best as VideoFrame | null)?.close()
    demuxer.destroy()
  }
}
