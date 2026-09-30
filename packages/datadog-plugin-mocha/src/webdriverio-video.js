'use strict'

const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { clearInterval, clearTimeout, setInterval, setTimeout } = require('node:timers')
const { Worker } = require('node:worker_threads')

const {
  VIDEO_UPLOAD_RESULT_ERROR,
  VIDEO_UPLOAD_RESULT_UPLOADED,
} = require('../../dd-trace/src/ci-visibility/test-video')
const log = require('../../dd-trace/src/log')

const CAPTURE_INTERVAL_MS = 500
const CAPTURE_TIMEOUT_MS = 5000
const ENCODING_TIMEOUT_MS = 30_000
const MAX_FRAME_BYTES = 200 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const { queueMicrotask } = globalThis
const captureOwners = new WeakMap()
// A local timeout does not cancel the WebDriver request; keep its slot until it actually settles.
const pendingCaptures = new WeakSet()

/** @type {Array<() => void>} */
const encodingQueue = []

/**
 * Runs one encoder at a time across all attempts in this WDIO process. Uploads do not hold the slot.
 *
 * @param {{ directory: string, index: number, frames: number, filePath: string }} workerData
 * @param {(error?: Error) => void} onDone
 */
function encodeVideo (workerData, onDone) {
  let worker
  let timeout
  const complete = error => {
    const index = encodingQueue.indexOf(start)
    if (index === -1) return
    encodingQueue.splice(index, 1)
    // Defer the next start so repeated Worker constructor failures cannot recurse through the queue.
    if (encodingQueue.length) queueMicrotask(encodingQueue[0])
    onDone(error)
  }
  const start = () => {
    // A queued start may have been cancelled before its microtask runs.
    if (worker || !encodingQueue.includes(start)) return
    try {
      worker = new Worker(join(__dirname, 'webdriverio-video-worker.js'), {
        execArgv: [],
        env: { NODE_OPTIONS: '' },
        workerData,
      })
      let encodingError
      timeout = setTimeout(() => {
        encodingError = new Error('WebdriverIO video encoding timed out')
        // Even if termination rejects, keep the slot and files until the worker actually exits.
        worker.terminate().catch(error => { encodingError = error })
      }, ENCODING_TIMEOUT_MS)
      worker.once('error', error => { encodingError = error })
      worker.once('exit', code => {
        clearTimeout(timeout)
        if (code !== 0) encodingError ||= new Error(`WebdriverIO video encoder exited with code ${code}`)
        complete(encodingError)
      })
    } catch (error) {
      // Let the caller retain its cancellation callback even when Worker construction throws.
      queueMicrotask(() => complete(error))
    }
  }
  encodingQueue.push(start)
  if (encodingQueue.length === 1) start()
  return () => {
    const index = encodingQueue.indexOf(start)
    if (index === -1) return
    if (worker) {
      clearTimeout(timeout)
      // Shutdown must not wait for a worker that cannot terminate. Keep its slot until exit.
      worker.unref?.()
      worker.terminate().catch(error => {
        log.error('Error stopping WebdriverIO video encoder: %s', error.message)
      })
    } else {
      encodingQueue.splice(index, 1)
      if (index === 0 && encodingQueue.length) queueMicrotask(encodingQueue[0])
    }
  }
}

// Like wdio-video-reporter, collect WebDriver screenshots and encode only failed attempts.
// Encoding runs in a worker with vendored WebAssembly, without an external executable.
class WebdriverioVideo {
  #browser
  #directory
  #frames = []
  #bytes = 0
  #capturing = false
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
    if (this.#stopped || this.#capturing || this.#error ||
        pendingCaptures.has(this.#browser) || captureOwners.get(this.#browser) !== this) return
    this.#capturing = true
    let completed = false
    const complete = (error, screenshots) => {
      if (completed || this.#finished) return
      completed = true
      clearTimeout(this.#captureTimeout)
      this.#capturing = false
      if (error) {
        log.error('Error capturing WebdriverIO video frame: %s', error.message)
      } else if (captureOwners.get(this.#browser) === this) {
        try {
          this.#writeFrames(screenshots)
        } catch (error) {
          this.#error = error
        }
      }
      const onCapture = this.#onCapture
      this.#onCapture = undefined
      onCapture?.()
    }
    this.#captureTimeout = setTimeout(() => {
      complete(new Error('WebdriverIO video screenshot capture timed out'))
    }, CAPTURE_TIMEOUT_MS)
    this.#captureTimeout.unref?.()
    try {
      if (this.#browser.isMultiremote) {
        const names = this.#browser.instances
        if (!names.length) return complete(new Error('WebdriverIO returned no browser sessions'))
        const browsers = names.map(name => this.#browser.getInstance(name))
        const frames = new Array(names.length)
        let pending = names.length
        pendingCaptures.add(this.#browser)
        for (let index = 0; index < names.length; index++) {
          this.#captureBrowser(browsers[index], (error, frame) => {
            if (--pending === 0) pendingCaptures.delete(this.#browser)
            if (error) return complete(error)
            frames[index] = frame
            if (pending === 0) complete(undefined, frames)
          })
        }
      } else {
        pendingCaptures.add(this.#browser)
        this.#captureBrowser(this.#browser, (error, frame) => {
          pendingCaptures.delete(this.#browser)
          complete(error, frame)
        })
      }
    } catch (error) {
      complete(error)
    }
  }

  /**
   * @param {object} browser - A single WebDriver session, including sessions with BiDi enabled
   * @param {(error?: Error, frame?: string) => void} onDone
   */
  #captureBrowser (browser, onDone) {
    try {
      // Use the session's WebDriver screenshot command. Direct BiDi captures can lose their
      // browsing context during concurrent navigation and never return a frame.
      browser.takeScreenshot().then(result => onDone(undefined, result), onDone)
    } catch (error) {
      onDone(error)
    }
  }

  /** @param {string|string[]} screenshots - Base64 PNG screenshots, in session order */
  #writeFrames (screenshots) {
    const frames = Array.isArray(screenshots) ? screenshots : [screenshots]
    if (!frames.length) throw new Error('WebdriverIO returned no video frames')
    for (let index = 0; index < frames.length; index++) {
      if (typeof frames[index] !== 'string') throw new Error('WebdriverIO returned an invalid video frame')
      const frame = Buffer.from(frames[index], 'base64')
      if (!frame.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        throw new Error('WebdriverIO returned an invalid PNG video frame')
      }
      if (this.#bytes + frame.length > MAX_FRAME_BYTES) {
        throw new Error('WebdriverIO video frames exceeded the 200 MiB recording limit')
      }
      const frameNumber = this.#frames[index] || 0
      writeFileSync(join(this.#directory, `${index}-${frameNumber}.png`), frame)
      this.#frames[index] = frameNumber + 1
      this.#bytes += frame.length
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
    if (failed) this.capture()
    this.#stopped = true
    clearInterval(this.#interval)
    this.#browser.removeListener?.('result', this.#onResult)
    const finish = () => {
      if (this.#finished) return
      if (!failed) return this.#cleanup(undefined, onDone)
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
      if (completed || this.#finished) return
      completed = true
      if (error) log.error('Error uploading WebdriverIO failure video: %s', error.message)
      this.#encode(index + 1, upload, hasError || Boolean(error), onDone)
    }
    const workerData = { directory: this.#directory, index, frames: this.#frames[index], filePath }
    this.#cancelEncoding = encodeVideo(workerData, error => {
      if (this.#finished) return
      if (error) return next(error)
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
    const onCapture = this.#onCapture
    this.#onCapture = undefined
    onCapture?.()
    try {
      rmSync(this.#directory, { recursive: true, force: true })
    } catch (error) {
      log.error('Error removing WebdriverIO video files: %s', error.message)
    }
    onDone(result)
  }
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
    return new WebdriverioVideo(browser)
  } catch (error) {
    log.error('Error starting WebdriverIO video recording: %s', error.message)
  }
}

module.exports = createWebdriverioVideo
