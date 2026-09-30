'use strict'

const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
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

  /** @param {object} browser - WebdriverIO browser or multiremote browser */
  constructor (browser) {
    this.#browser = browser
    this.#directory = mkdtempSync(join(tmpdir(), 'dd-trace-wdio-video-'))
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
    if (this.#stopped || this.#capturing || this.#error) return
    this.#capturing = true
    let completed = false
    const complete = (error, screenshots) => {
      if (completed) return
      completed = true
      clearTimeout(this.#captureTimeout)
      this.#capturing = false
      if (error) {
        this.#error = error
      } else {
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
        const frames = new Array(names.length)
        let pending = names.length
        for (let index = 0; index < names.length; index++) {
          this.#captureBrowser(this.#browser.getInstance(names[index]), (error, frame) => {
            if (error) return complete(error)
            frames[index] = frame
            if (--pending === 0) complete(undefined, frames)
          })
        }
      } else {
        this.#captureBrowser(this.#browser, complete)
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
    if (failed) this.capture()
    this.#stopped = true
    clearInterval(this.#interval)
    this.#browser.removeListener?.('result', this.#onResult)
    const finish = () => {
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
      if (error) log.error('Error uploading WebdriverIO failure video: %s', error.message)
      this.#encode(index + 1, upload, hasError || Boolean(error), onDone)
    }
    try {
      const worker = new Worker(join(__dirname, 'webdriverio-video-worker.js'), {
        execArgv: [],
        env: { NODE_OPTIONS: '' },
        workerData: { directory: this.#directory, index, frames: this.#frames[index], filePath },
      })
      let encodingError
      const timeout = setTimeout(() => {
        encodingError = new Error('WebdriverIO video encoding timed out')
        worker.terminate().catch(next)
      }, ENCODING_TIMEOUT_MS)
      worker.once('error', error => { encodingError = error })
      worker.once('exit', code => {
        clearTimeout(timeout)
        if (encodingError || code !== 0) {
          return next(encodingError || new Error(`WebdriverIO video encoder exited with code ${code}`))
        }
        try {
          upload(filePath, index, next)
        } catch (error) {
          next(error)
        }
      })
    } catch (error) {
      next(error)
    }
  }

  /**
   * @param {string|undefined} result
   * @param {(result?: string) => void} onDone
   */
  #cleanup (result, onDone) {
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
