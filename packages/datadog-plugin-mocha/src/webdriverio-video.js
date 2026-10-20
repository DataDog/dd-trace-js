'use strict'

const { spawn, spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { performance } = require('node:perf_hooks')
const { clearInterval, clearTimeout, setInterval, setTimeout } = require('node:timers')

const {
  VIDEO_UPLOAD_RESULT_ERROR,
  VIDEO_UPLOAD_RESULT_UPLOADED,
} = require('../../dd-trace/src/ci-visibility/test-video')
const log = require('../../dd-trace/src/log')

const CAPTURE_INTERVAL_MS = 500
const CAPTURE_TIMEOUT_MS = 5000
const ENCODING_TIMEOUT_MS = 30_000
const MAX_PENDING_ENCODINGS = 32
const MAX_PIXELS = 16 * 1024 * 1024
const MAX_FRAME_BYTES = 200 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const { queueMicrotask } = globalThis
const captureOwners = new WeakMap()
// A local timeout does not cancel the WebDriver request; keep its slot until it actually settles.
const pendingCaptures = new WeakSet()
const unsafePromptBrowsers = new WeakSet()

let ffmpegAvailable
// PNGs remain charged through encoding and upload, until their temporary files are removed.
let frameBytes = 0

/** @type {Array<() => void>} */
const encodingQueue = []

/**
 * Runs one encoder at a time across all attempts in this WDIO process. Uploads do not hold the slot.
 *
 * @param {{ directory: string, index: number, frames: number[], filePath: string, size: number[] }} recording
 * @param {(error?: Error) => void} onDone
 */
function encodeVideo (recording, onDone) {
  // Include the active encoder in the queue limit.
  if (encodingQueue.length > MAX_PENDING_ENCODINGS) {
    queueMicrotask(() => onDone(new Error('WebdriverIO video encoding queue is full')))
    return
  }
  let encoder
  let timeout
  const complete = error => {
    const index = encodingQueue.indexOf(start)
    if (index === -1) return
    encodingQueue.splice(index, 1)
    // Defer the next start so repeated process startup failures cannot recurse through the queue.
    if (encodingQueue.length) queueMicrotask(encodingQueue[0])
    onDone(error)
  }
  const start = () => {
    // A queued start may have been cancelled before its microtask runs.
    if (encoder || !encodingQueue.includes(start)) return
    try {
      const { directory, index, frames, filePath, size: [width, height] } = recording
      const manifestPath = join(directory, `${index}.ffconcat`)
      let manifest = 'ffconcat version 1.0\n'
      for (let frame = 0; frame < frames.length; frame++) {
        // Command captures are irregular: fixed 2 fps stretches assertion polling into long videos.
        const duration = frame + 1 < frames.length ? (frames[frame + 1] - frames[frame]) / 1000 : 0.04
        manifest += `file ${index}-${frame}.png\nduration ${duration.toFixed(6)}\n`
      }
      // The PNG demuxer uses 25 Hz timestamps. Repeat the final image one tick later so it survives
      // rounding when the last two captures are less than 40 ms apart. WebM preserves variable timing.
      manifest += `file ${index}-${frames.length - 1}.png\n`
      writeFileSync(manifestPath, manifest)
      encoder = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-threads', '1', '-f', 'concat', '-i', manifestPath,
        '-frames:v', String(frames.length + 1), '-an', '-c:v', 'libvpx', '-deadline', 'realtime',
        '-threads', '1', '-filter_threads', '1', '-pix_fmt', 'yuv420p',
        '-vf', `scale=${width}:${height},setsar=1`, filePath,
      ], { windowsHide: true, stdio: 'ignore' })
      let encodingError
      timeout = setTimeout(() => {
        encodingError = new Error('WebdriverIO video encoding timed out')
        // A kill request does not release the slot until the process actually closes.
        encoder.kill('SIGKILL')
      }, ENCODING_TIMEOUT_MS)
      encoder.once('error', error => { encodingError = error })
      encoder.once('close', code => {
        clearTimeout(timeout)
        if (code !== 0) encodingError ||= new Error(`WebdriverIO video encoder exited with code ${code}`)
        complete(encodingError)
      })
    } catch (error) {
      // Let the caller retain its cancellation callback even when process startup throws.
      queueMicrotask(() => complete(error))
    }
  }
  encodingQueue.push(start)
  if (encodingQueue.length === 1) start()
  return () => {
    const index = encodingQueue.indexOf(start)
    if (index === -1) return
    if (encoder) {
      clearTimeout(timeout)
      // Shutdown must not wait for a process that cannot terminate. Keep its slot until close.
      encoder.unref?.()
      if (!encoder.kill('SIGKILL')) log.error('Error stopping WebdriverIO video encoder')
    } else {
      encodingQueue.splice(index, 1)
      if (index === 0 && encodingQueue.length) queueMicrotask(encodingQueue[0])
    }
  }
}

// Like wdio-video-reporter, collect WebDriver screenshots and encode only failed attempts.
// Encoding uses a customer-installed FFmpeg executable, isolated from the WDIO test process.
class WebdriverioVideo {
  #browser
  #directory
  #frames = []
  #sizes = []
  #bytes = 0
  #capturing = false
  #finalCapture = false
  #completeCapture
  #disabled = false
  #stopped = false
  #captureTimeout
  #interval
  #onCapture
  #error
  #onResult
  #cancelEncoding
  #finished = false
  #onDone

  /** @param {object} browser - WebdriverIO browser or multiremote browser */
  constructor (browser) {
    this.#browser = browser
    this.#directory = mkdtempSync(join(tmpdir(), 'dd-trace-wdio-video-'))
    captureOwners.set(browser, this)
    this.#onResult = /** @param {{command?: string, endpoint?: string}} event */ (event) => {
      const { command, endpoint } = event
      if (command === 'takeScreenshot' || endpoint?.endsWith('/screenshot')) return
      // WDIO looks up the context before BiDi navigation. Capturing in that gap can block navigation.
      if (command === 'getWindowHandle' || command === 'getWindowHandles') return
      this.capture()
    }
    browser.on?.('result', this.#onResult)
    this.#interval = setInterval(() => this.capture(), CAPTURE_INTERVAL_MS)
    this.#interval.unref?.()
    this.capture()
  }

  /** Captures at most one in-flight screenshot, including all multiremote sessions. */
  capture () {
    if ((this.#stopped && !this.#finalCapture) || this.#capturing || this.#error || this.#disabled ||
        pendingCaptures.has(this.#browser) || captureOwners.get(this.#browser) !== this) return
    this.#finalCapture = false
    this.#capturing = true
    let completed = false
    const complete = (error, screenshots, capturedAt) => {
      if (completed || this.#finished) return
      completed = true
      this.#capturing = false
      if (error) {
        log.error('Error capturing WebdriverIO video frame: %s', error.message)
      } else if (!this.#disabled && captureOwners.get(this.#browser) === this) {
        try {
          this.#writeFrames(screenshots, capturedAt)
        } catch (error) {
          this.#error = error
        }
      }
      if (this.#finalCapture) {
        this.capture()
        if (this.#capturing) return
      }
      this.#finalCapture = false
      clearTimeout(this.#captureTimeout)
      this.#captureTimeout = undefined
      this.#completeCapture = undefined
      const onCapture = this.#onCapture
      this.#onCapture = undefined
      onCapture?.()
    }
    this.#completeCapture = complete
    // An overlapping capture and its fresh final frame share the existing five-second deadline.
    this.#captureTimeout ??= setTimeout(() => {
      this.#completeCapture?.(new Error('WebdriverIO video screenshot capture timed out'))
    }, CAPTURE_TIMEOUT_MS)
    this.#captureTimeout.unref?.()
    try {
      if (!hasSafePromptPolicy(this.#browser)) {
        this.#disabled = true
        clearInterval(this.#interval)
        this.#browser.removeListener?.('result', this.#onResult)
        return complete()
      }
      if (this.#browser.isMultiremote || this.#browser.isMultiRemote) {
        const names = this.#browser.instances
        if (!names.length) return complete(new Error('WebdriverIO returned no browser sessions'))
        const browsers = names.map(name => this.#browser.getInstance(name))
        const frames = new Array(names.length)
        const captureTimes = new Array(names.length)
        let pending = names.length
        let captureError
        pendingCaptures.add(this.#browser)
        for (let index = 0; index < names.length; index++) {
          this.#captureBrowser(browsers[index], (error, frame, capturedAt) => {
            captureError ||= error
            frames[index] = frame
            captureTimes[index] = capturedAt
            if (--pending === 0) {
              pendingCaptures.delete(this.#browser)
              complete(captureError, frames, captureTimes)
            }
          })
        }
      } else {
        pendingCaptures.add(this.#browser)
        this.#captureBrowser(this.#browser, (error, frame, capturedAt) => {
          pendingCaptures.delete(this.#browser)
          complete(error, frame, capturedAt)
        })
      }
    } catch (error) {
      complete(error)
    }
  }

  /**
   * @param {object} browser - A single WebDriver session, including sessions with BiDi enabled
   * @param {(error?: Error, frame?: string, capturedAt?: number) => void} onDone
   */
  #captureBrowser (browser, onDone) {
    try {
      // Use the session's WebDriver screenshot command. Direct BiDi captures can lose their
      // browsing context during concurrent navigation and never return a frame.
      // Timestamp each session before waiting for the rest of a multiremote batch.
      browser.takeScreenshot().then(result => onDone(undefined, result, performance.now()), onDone)
    } catch (error) {
      onDone(error)
    }
  }

  /**
   * @param {string|string[]} screenshots - Base64 PNG screenshots, in session order
   * @param {number|number[]} capturedAt - Completion timestamps in the same session order
   */
  #writeFrames (screenshots, capturedAt) {
    const frames = Array.isArray(screenshots) ? screenshots : [screenshots]
    if (!frames.length) throw new Error('WebdriverIO returned no video frames')
    for (let index = 0; index < frames.length; index++) {
      if (typeof frames[index] !== 'string') throw new Error('WebdriverIO returned an invalid video frame')
      if (Buffer.byteLength(frames[index], 'base64') > MAX_FRAME_BYTES - frameBytes) {
        throw new Error('WebdriverIO video frames exceeded the 200 MiB worker limit')
      }
      const frame = Buffer.from(frames[index], 'base64')
      if (frame.length < 24 || !frame.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        throw new Error('WebdriverIO returned an invalid PNG video frame')
      }
      const width = frame.readUInt32BE(16)
      const height = frame.readUInt32BE(20)
      if (!width || !height || width * height > MAX_PIXELS) {
        throw new Error('WebdriverIO video frame exceeds the 16 megapixel limit or has invalid dimensions')
      }
      if (!this.#sizes[index]) {
        // Keep a fixed, even output size across viewport changes.
        const scale = Math.min(1, 1280 / width, 720 / height)
        this.#sizes[index] = [
          Math.max(2, Math.floor(width * scale / 2) * 2),
          Math.max(2, Math.floor(height * scale / 2) * 2),
        ]
      }
      const timestamps = this.#frames[index] ||= []
      const frameNumber = timestamps.length
      // Reserve before writing so a partial write stays accounted for until cleanup.
      frameBytes += frame.length
      this.#bytes += frame.length
      writeFileSync(join(this.#directory, `${index}-${frameNumber}.png`), frame)
      timestamps.push(Array.isArray(capturedAt) ? capturedAt[index] : capturedAt)
    }
  }

  /**
   * Stops capture, uploads failed attempts, and removes all owned files after upload completion.
   *
   * @param {boolean} failed - Whether this attempt failed
   * @param {(filePath: string, index: number, onDone: (error?: Error) => void) => void} upload
   * @param {(result?: string) => void} onDone
   */
  finish (failed, upload, onDone) {
    if (this.#stopped) return
    this.#onDone = onDone
    if (failed) {
      if (this.#capturing) this.#finalCapture = true
      else this.capture()
    }
    this.#stopped = true
    clearInterval(this.#interval)
    this.#browser.removeListener?.('result', this.#onResult)
    const finish = () => {
      if (this.#finished) return
      if (!failed || this.#disabled) return this.#cleanup(undefined, onDone)
      if (this.#error || !this.#frames.length) {
        log.error('Error recording WebdriverIO failure video: %s', this.#error?.message || 'No frames captured')
        return this.#cleanup(VIDEO_UPLOAD_RESULT_ERROR, onDone)
      }
      this.#encode(0, upload, false, onDone)
    }
    if (this.#capturing) this.#onCapture = finish
    else finish()
  }

  /** @param {() => void} onDone - Releases a retry once this attempt's final capture settles. */
  waitForCapture (onDone) {
    if (!this.#capturing || this.#finished) return onDone()
    const previous = this.#onCapture
    this.#onCapture = () => {
      previous?.()
      onDone()
    }
  }

  /** Cancels a finishing attempt at the worker's final-flush deadline. */
  cancel () {
    if (this.#finished) return
    this.#cancelEncoding?.()
    this.#cleanup(VIDEO_UPLOAD_RESULT_ERROR, this.#onDone)
  }

  /**
   * Encodes multiremote sessions sequentially to bound encoder resource use.
   *
   * @param {number} index
   * @param {(filePath: string, index: number, onDone: (error?: Error) => void) => void} upload
   * @param {boolean} hasError
   * @param {(result?: string) => void} onDone
   */
  #encode (index, upload, hasError, onDone) {
    if (index === this.#frames.length) {
      return this.#cleanup(hasError ? VIDEO_UPLOAD_RESULT_ERROR : VIDEO_UPLOAD_RESULT_UPLOADED, onDone)
    }
    const filePath = join(this.#directory, `${index}.webm`)
    let completed = false
    const next = error => {
      if (completed) return
      completed = true
      // Cancellation may try cleanup while encoding or upload still holds files open.
      if (this.#finished) return this.#cleanup(undefined, () => {})
      if (error) log.error('Error uploading WebdriverIO failure video: %s', error.message)
      this.#encode(index + 1, upload, hasError || Boolean(error), onDone)
    }
    const recording = {
      directory: this.#directory,
      index,
      frames: this.#frames[index],
      filePath,
      size: this.#sizes[index],
    }
    this.#cancelEncoding = encodeVideo(recording, error => {
      if (this.#finished || error) return next(error)
      try {
        upload(filePath, index, next)
      } catch (error) {
        next(error)
      }
    })
  }

  /**
   * @param {string|undefined} result
   * @param {(result?: string) => void} onDone
   */
  #cleanup (result, onDone) {
    this.#finished = true
    if (captureOwners.get(this.#browser) === this) captureOwners.delete(this.#browser)
    clearTimeout(this.#captureTimeout)
    this.#completeCapture = undefined
    const onCapture = this.#onCapture
    this.#onCapture = undefined
    onCapture?.()
    try {
      rmSync(this.#directory, { recursive: true, force: true })
      frameBytes -= this.#bytes
      this.#bytes = 0
    } catch (error) {
      log.error('Error removing WebdriverIO video files: %s', error.message)
    }
    onDone(result)
  }
}

/** @param {object} browser - Current WebdriverIO browser or multiremote browser */
function hasSafePromptPolicy (browser) {
  const sessions = (browser.isMultiremote || browser.isMultiRemote)
    ? browser.instances.map(name => browser.getInstance(name))
    : [browser]
  for (const session of sessions) {
    const behavior = session.capabilities?.unhandledPromptBehavior
    if (behavior === 'ignore' || (behavior?.default === 'ignore' &&
      Object.values(behavior).every(value => value === 'ignore'))) continue
    if (!unsafePromptBrowsers.has(browser)) {
      unsafePromptBrowsers.add(browser)
      log.warn('WebdriverIO failure video recording is disabled: every session must use %s to preserve open dialogs.',
        'unhandledPromptBehavior: "ignore"')
    }
    return false
  }
  return true
}

/** Checks FFmpeg once in the worker, before configuring browser sessions or recording attempts. */
function isFfmpegAvailable () {
  if (ffmpegAvailable !== undefined) return ffmpegAvailable
  ffmpegAvailable = false
  try {
    const result = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], {
      timeout: 5000, killSignal: 'SIGKILL', windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    ffmpegAvailable = !result.error && result.status === 0 && /^[ \t]*V\S{5}[ \t]+libvpx[ \t]/m.test(result.stdout)
  } catch (error) {
    log.error('Error checking WebdriverIO video FFmpeg availability: %s', error.message)
  }
  if (!ffmpegAvailable) {
    log.warn('WebdriverIO failure video recording requires FFmpeg on PATH with the libvpx encoder.')
  }
  return ffmpegAvailable
}

/**
 * Creates a recorder when a browser is available. The encoder is loaded only for failed attempts.
 *
 * @param {object} browser
 * @returns {WebdriverioVideo|void}
 */
function createWebdriverioVideo (browser) {
  if (typeof browser?.takeScreenshot !== 'function') return
  try {
    if (ffmpegAvailable === false || !hasSafePromptPolicy(browser) || !isFfmpegAvailable()) return
    return new WebdriverioVideo(browser)
  } catch (error) {
    log.error('Error starting WebdriverIO video recording: %s', error.message)
  }
}

module.exports = createWebdriverioVideo
module.exports.isFfmpegAvailable = isFfmpegAvailable
