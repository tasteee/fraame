import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type InputVideoTrack, type Rotation } from 'mediabunny'

// Dimensions here are always *display* dimensions: mediabunny has already
// applied the container's rotation and pixel aspect ratio, so nothing
// downstream has to swap width and height for a portrait clip.
export type VideoInfoT = {
  fileName: string
  displayWidth: number
  displayHeight: number
  rotation: Rotation
  fps: number
  durationSec: number
  firstTimestampSec: number
  codecName: string
}

export type ProbeResultT = {
  input: Input
  track: InputVideoTrack
  info: VideoInfoT
}

// Frame rate is estimated from a sample of packets rather than the whole
// track. A few hundred is plenty to recognise 24/25/30/60 and keeps the probe
// from reading the entire file before the upload screen can respond.
const FPS_SAMPLE_PACKETS = 300

export const normalizeRotation = (value: number): Rotation => {
  const quarters = Math.round(value / 90) * 90
  const wrapped = ((quarters % 360) + 360) % 360
  return wrapped as Rotation
}

// Total frames the file is expected to hold. Derived from fps and duration
// rather than counted, so the viewer knows its range the moment the probe
// finishes instead of after a full decode pass.
export const getFrameCount = (info: VideoInfoT): number => {
  return Math.max(1, Math.floor(info.durationSec * info.fps))
}

// Timestamps in a track do not necessarily start at zero, and every sink here
// is addressed in absolute track time.
export const getAbsoluteTimeSec = (info: VideoInfoT, index: number): number => {
  return info.firstTimestampSec + index / info.fps
}

// Reading the duration out of the container header is a couple of hundred
// bytes; computing it walks every packet. Worth trying the cheap path first,
// because on a long .mkv the difference is the whole upload screen.
const readDuration = async (track: InputVideoTrack): Promise<number> => {
  const declared = await track.getDurationFromMetadata()
  const isUsable = declared !== null && declared > 0
  if (isUsable) return declared as number
  return await track.computeDuration()
}

export const probeVideo = async (file: File): Promise<ProbeResultT> => {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })

  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('No video stream found in this file.')

    // Checked here rather than at first decode so an unsupported codec is
    // reported while the user is still on the upload screen.
    const canDecode = await track.canDecode()
    if (!canDecode) {
      const codecName = track.codec ?? 'this'
      throw new Error(`This browser can't decode ${codecName} video.`)
    }

    const [durationSec, displayWidth, displayHeight, rotation, firstTimestampSec, packetStats] = await Promise.all([
      readDuration(track),
      track.getDisplayWidth(),
      track.getDisplayHeight(),
      track.getRotation(),
      track.getFirstTimestamp(),
      track.computePacketStats(FPS_SAMPLE_PACKETS),
    ])

    const fps = packetStats.averagePacketRate
    if (!fps || !durationSec) throw new Error('Could not read the frame rate or duration of this video.')

    return {
      input,
      track,
      info: {
        fileName: file.name,
        displayWidth,
        displayHeight,
        rotation,
        fps,
        durationSec,
        firstTimestampSec,
        codecName: track.codec ?? 'unknown',
      },
    }
  } catch (error) {
    input.dispose()
    throw error
  }
}

export const displaySize = (info: VideoInfoT, maxDim: number) => {
  const largestSide = Math.max(info.displayWidth, info.displayHeight)
  const scale = Math.min(1, maxDim / largestSide)

  return {
    outW: Math.max(2, Math.round(info.displayWidth * scale)),
    outH: Math.max(2, Math.round(info.displayHeight * scale)),
  }
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

// Re-decodes a single frame at full resolution and returns it as a PNG. This
// runs on the same Input as the scrubbing sink — media sinks are independent,
// so an export never disturbs a scrub in progress, and there is no second
// demuxer to keep warm.
//
// The sink is built per call on purpose: exporting is a deliberate, rare
// action, and holding a decoder open between saves buys nothing.
export const extractFullResFrame = async (
  track: InputVideoTrack,
  info: VideoInfoT,
  timeSec: number,
  viewRotation = 0,
): Promise<Blob> => {
  const sink = new VideoSampleSink(track, { hardwareAcceleration: 'prefer-hardware' })
  const sample = await sink.getSample(info.firstTimestampSec + timeSec)
  if (!sample) throw new Error('No frame decoded at that time.')

  try {
    // The sample already knows the container's rotation; the view rotation is
    // whatever the user has added on top of it.
    const totalRotation = normalizeRotation(sample.rotation + viewRotation)
    const isSideways = viewRotation === 90 || viewRotation === 270
    const outW = isSideways ? info.displayHeight : info.displayWidth
    const outH = isSideways ? info.displayWidth : info.displayHeight

    const canvas = new OffscreenCanvas(outW, outH)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not create a canvas context.')

    sample.drawWithFit(ctx, { fit: 'fill', rotation: totalRotation })
    return await canvas.convertToBlob({ type: 'image/png' })
  } finally {
    sample.close()
  }
}
