// Sliding-window ImageBitmap cache: decoded bitmaps are kept only around the
// current frame so scrubbing is instant while memory stays bounded.
export const createBitmapCache = (getBlob: (index: number) => Blob | undefined) => {
  const bitmaps = new Map<number, ImageBitmap>()
  const pending = new Map<number, Promise<ImageBitmap | undefined>>()

  const load = (index: number): Promise<ImageBitmap | undefined> => {
    const cached = bitmaps.get(index)
    if (cached) return Promise.resolve(cached)
    const inFlight = pending.get(index)
    if (inFlight) return inFlight
    const blob = getBlob(index)
    if (!blob) return Promise.resolve(undefined)
    const promise = createImageBitmap(blob)
      .then((bitmap) => {
        pending.delete(index)
        bitmaps.set(index, bitmap)
        return bitmap
      })
      .catch(() => {
        pending.delete(index)
        return undefined
      })
    pending.set(index, promise)
    return promise
  }

  const prefetch = (center: number, radius: number, total: number) => {
    for (let distance = 1; distance <= radius; distance++) {
      const ahead = center + distance
      const behind = center - distance
      if (ahead < total) void load(ahead)
      if (behind >= 0) void load(behind)
    }
    for (const [index, bitmap] of bitmaps) {
      if (Math.abs(index - center) > radius * 3) {
        bitmap.close()
        bitmaps.delete(index)
      }
    }
  }

  const clear = () => {
    for (const bitmap of bitmaps.values()) bitmap.close()
    bitmaps.clear()
    pending.clear()
  }

  return { load, prefetch, clear }
}
