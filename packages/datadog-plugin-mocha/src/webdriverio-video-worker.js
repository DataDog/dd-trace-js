'use strict'

const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { workerData } = require('node:worker_threads')

const {
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Output,
  WebMOutputFormat,
  createEncoder,
  decodePng,
  defaultOptions,
} = require('../../../vendor/dist/webdriverio-video')

const MAX_PIXELS = 16 * 1024 * 1024
const { directory, index, frames, filePath } = workerData

/** Encodes one browser's screenshot sequence, isolated from the WDIO test thread. */
async function encode () {
  const encoder = await createEncoder({
    wasmBinary: readFileSync(join(__dirname, '../../../vendor/dist/webdriverio-video/webp_enc.wasm')),
  })
  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() })
  const source = new EncodedVideoPacketSource('vp8')
  output.addVideoTrack(source, { frameRate: 2 })
  await output.start()
  let width = 0
  let height = 0
  for (let frame = 0; frame < frames; frame++) {
    const png = readFileSync(join(directory, `${index}-${frame}.png`))
    // Bound decompression before the PNG decoder allocates the pixel buffer.
    if (png.length < 24 || png.readUInt32BE(16) * png.readUInt32BE(20) > MAX_PIXELS) {
      throw new Error('WebdriverIO video frame exceeds the 16 megapixel limit')
    }
    const image = decodePng(png, {})
    if (width === 0) {
      const scale = Math.min(1, 1280 / image.width, 720 / image.height)
      width = Math.max(1, Math.round(image.width * scale))
      height = Math.max(1, Math.round(image.height * scale))
    }
    const pixels = resize(image, width, height)
    const webp = encoder.encode(pixels, width, height, { ...defaultOptions, method: 0 })
    if (!webp) throw new Error('WebdriverIO video frame encoding failed')
    const packet = new EncodedPacket(extractVp8(webp), 'key', frame / 2, 0.5)
    // eslint-disable-next-line no-await-in-loop -- bound memory by writing one frame at a time
    await source.add(packet, { decoderConfig: { codec: 'vp8', codedWidth: width, codedHeight: height } })
  }
  await output.finalize()
  const { buffer } = output.target
  writeFileSync(filePath, new Uint8Array(/** @type {ArrayBuffer} */ (buffer)))
}

/**
 * Keeps dimensions stable across viewport changes and bounds encoding work.
 *
 * @param {{ width: number, height: number, data: Buffer }} image
 * @param {number} width
 * @param {number} height
 */
function resize (image, width, height) {
  if (image.width === width && image.height === height) {
    return new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.byteLength)
  }
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y * image.height / height) * image.width
    for (let x = 0; x < width; x++) {
      const source = (row + Math.floor(x * image.width / width)) * 4
      const target = (y * width + x) * 4
      pixels[target] = image.data[source]
      pixels[target + 1] = image.data[source + 1]
      pixels[target + 2] = image.data[source + 2]
      pixels[target + 3] = image.data[source + 3]
    }
  }
  return pixels
}

/** @param {Uint8Array} webp - Lossy WebP contains a VP8 keyframe usable in a WebM video track. */
function extractVp8 (webp) {
  const buffer = Buffer.from(webp.buffer, webp.byteOffset, webp.byteLength)
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(offset + 4)
    const end = offset + 8 + size
    if (end > buffer.length) break
    if (buffer.toString('ascii', offset, offset + 4) === 'VP8 ') return buffer.subarray(offset + 8, end)
    offset = end + (size & 1)
  }
  throw new Error('WebdriverIO video encoder returned no VP8 frame')
}

// A rejected encode becomes the worker's error event; the recorder logs it and cleans up.
encode().catch(error => { throw error })
