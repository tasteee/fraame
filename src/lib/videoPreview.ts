import type { VideoInfoT } from './video'

// The browser's own decoder, driven straight off the original file. It can't
// name frames — currentTime is a time, not an index, and variable frame rate
// means 1/fps is not always a real frame boundary — so this never decides
// which frame the user saved. It exists purely so something moves on screen
// while the exact WebCodecs path is still working, which is the difference
// between a scrub that feels soft and one that feels broken.
//
// It is also allowed to fail. A container ffmpeg can demux but the browser
// can't play natively (mkv, avi, wmv) leaves the preview unusable, and the
// viewer simply carries on without it.

// Seeks are coalesced to one per animation frame, and a seek already in
// flight is never interrupted — the newest requested time is committed as
// soon as the previous one presents. Queueing every pointermove instead is
// what leaves a phone decoding seconds of positions the finger already left.

export type VideoPreviewT = {
  element: HTMLVideoElement
  isUsable: () => boolean
  seekTo: (timeSec: number) => void
  destroy: () => void
}

export type VideoPreviewParamsT = {
  file: File
  info: VideoInfoT
  onPresented: () => void
}

// Below this the committed time is close enough that reseeking would only
// burn a decode to land on the same picture.
const SEEK_DEDUPE_SEC = 0.001

const hasFrameCallback = (element: HTMLVideoElement): boolean => {
  return typeof element.requestVideoFrameCallback === 'function'
}

export const createVideoPreview = (params: VideoPreviewParamsT): VideoPreviewT => {
  const sourceUrl = URL.createObjectURL(params.file)
  const element = document.createElement('video')

  element.src = sourceUrl
  element.preload = 'metadata'
  element.playsInline = true
  element.muted = true
  element.className = 'preview-video'
  element.setAttribute('aria-hidden', 'true')

  let isUnusable = false
  let isMetadataReady = false
  let isDestroyed = false
  let desiredTime = 0
  let animationFrame = 0
  let isSeekInFlight = false

  const markUnusable = () => {
    isUnusable = true
  }

  const isUsable = (): boolean => {
    const isReady = isMetadataReady && !isUnusable && !isDestroyed
    return isReady && element.videoWidth > 0
  }

  const scheduleCommit = () => {
    if (isDestroyed || isUnusable) return
    if (animationFrame !== 0) return
    animationFrame = requestAnimationFrame(commitNewestSeek)
  }

  const finishSeek = (committedTime: number) => {
    isSeekInFlight = false
    if (isDestroyed) return

    params.onPresented()

    // Whatever the finger did while that seek was in flight is still pending.
    const hasNewerRequest = Math.abs(desiredTime - committedTime) > SEEK_DEDUPE_SEC
    if (hasNewerRequest) scheduleCommit()
  }

  const commitNewestSeek = () => {
    animationFrame = 0
    if (isDestroyed || isUnusable) return
    if (isSeekInFlight) return
    if (!isMetadataReady) return

    const committedTime = desiredTime
    const isAlreadyThere = Math.abs(element.currentTime - committedTime) <= SEEK_DEDUPE_SEC
    if (isAlreadyThere) return

    isSeekInFlight = true
    element.currentTime = committedTime

    if (hasFrameCallback(element)) {
      element.requestVideoFrameCallback(() => finishSeek(committedTime))
      return
    }

    element.addEventListener('seeked', () => finishSeek(committedTime), { once: true })
  }

  const seekTo = (timeSec: number) => {
    if (isDestroyed || isUnusable) return

    const duration = Number.isFinite(element.duration) ? element.duration : params.info.durationSec
    desiredTime = Math.min(duration, Math.max(0, timeSec))
    scheduleCommit()
  }

  const handleMetadata = () => {
    isMetadataReady = true
    scheduleCommit()
  }

  element.addEventListener('loadedmetadata', handleMetadata)
  element.addEventListener('error', markUnusable)

  // Some browsers throttle or skip presentation for a detached element, so it
  // lives in the document — clipped to a pixel rather than display:none,
  // which would stop it rendering at all.
  document.body.appendChild(element)

  const destroy = () => {
    if (isDestroyed) return
    isDestroyed = true

    if (animationFrame !== 0) cancelAnimationFrame(animationFrame)
    element.removeEventListener('loadedmetadata', handleMetadata)
    element.removeEventListener('error', markUnusable)
    element.remove()
    element.removeAttribute('src')
    element.load()
    URL.revokeObjectURL(sourceUrl)
  }

  return { element, isUsable, seekTo, destroy }
}
