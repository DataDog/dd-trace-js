'use strict'

const { execFile, spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

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
let ffmpegAvailable

// Like wdio-video-reporter, collect WebDriver screenshots and encode only failed attempts.
// This implementation uses Node APIs and an installed FFmpeg, without the reporter or its dependencies.
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
          }, () => completed)
        }
      } else {
        this.#captureBrowser(this.#browser, complete, () => completed)
      }
    } catch (error) {
      complete(error)
    }
  }

  /**
   * @param {object} browser - A single session, whose isBidi property is a boolean
   * @param {(error?: Error, frame?: string) => void} onDone
   * @param {() => boolean} completed
   */
  #captureBrowser (browser, onDone, completed) {
    const capture = /** @param {string} [context] */ context => {
      if (completed()) return
      try {
        const screenshot = context
          ? browser.browsingContextCaptureScreenshot({ context, origin: 'viewport', format: { type: 'image/png' } })
          : browser.takeScreenshot()
        screenshot.then(result => onDone(undefined, context ? result.data : result), onDone)
      } catch (error) {
        onDone(error)
      }
    }
    if (browser.isBidi) browser.getWindowHandle().then(capture, onDone)
    else capture()
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
    // execFile avoids shell interpretation of paths. VP8 WebM works with the existing media endpoint.
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-framerate', '2', '-i', join(this.#directory, `${index}-%d.png`),
      '-an', '-c:v', 'libvpx', '-deadline', 'realtime', '-threads', '1', '-pix_fmt', 'yuv420p',
      '-vf', 'scale=ceil(iw/2)*2:ceil(ih/2)*2', filePath,
    ]
    let completed = false
    const next = error => {
      if (completed) return
      completed = true
      if (error) log.error('Error uploading WebdriverIO failure video: %s', error.message)
      this.#encode(index + 1, upload, hasError || Boolean(error), onDone)
    }
    try {
      execFile('ffmpeg', args, {
        timeout: ENCODING_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        windowsHide: true,
        maxBuffer: 64 * 1024,
      }, error => {
        if (error) return next(error)
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
 * Creates a recorder only when an installed encoder and a browser are available.
 *
 * @param {object} browser
 * @returns {WebdriverioVideo|void}
 */
function createWebdriverioVideo (browser) {
  if (typeof browser?.takeScreenshot !== 'function') return
  if (ffmpegAvailable === undefined) {
    try {
      const result = spawnSync('ffmpeg', ['-version'], { timeout: 5000, windowsHide: true, stdio: 'ignore' })
      ffmpegAvailable = !result.error && result.status === 0
    } catch {
      ffmpegAvailable = false
    }
    if (!ffmpegAvailable) {
      log.warn('DD_TEST_FAILURE_VIDEOS_ENABLED is true, but WebdriverIO video recording requires FFmpeg on PATH.')
    }
  }
  if (!ffmpegAvailable) return
  try {
    return new WebdriverioVideo(browser)
  } catch (error) {
    log.error('Error starting WebdriverIO video recording: %s', error.message)
  }
}

module.exports = createWebdriverioVideo
