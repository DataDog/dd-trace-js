'use strict'

const { join } = require('node:path')
const { Worker } = require('node:worker_threads')

const { allocationDefaults } = require('../constants')

// eslint-disable-next-line eslint-rules/eslint-process-env
const { NODE_OPTIONS, ...workerEnv } = process.env

/**
 * Allocation profiler that tracks object allocations via V8's
 * HeapProfiler inspector API running in a dedicated worker thread.
 */
class AllocationProfiler {
  #worker
  #config
  #logger
  #started = false
  #windowActive = false
  #pendingResolve
  #pendingReject
  #disabled = false
  #windowTimer
  #heapMonitorTimer
  #cachedProfileToken
  #windowStartDate

  get type () { return 'allocation' }

  /**
   * @param {object} options - Profiler config options
   * @param {object} options.allocationProfiling - Allocation profiling config
   * @param {number} options.allocationProfiling.maxHeapBytes - Heap limit in bytes; window stops if exceeded
   * @param {object} [options.logger] - Logger instance
   */
  constructor (options = {}) {
    this.#config = options.allocationProfiling || {
      maxHeapBytes: allocationDefaults.MAX_HEAP_BYTES,
    }
    this.#logger = options.logger
  }

  /**
   * Spawn the worker thread and start the first tracking window if the
   * process is eligible based on current heap size.
   */
  start () {
    if (this.#started || this.#disabled) return

    this.#worker = new Worker(
      join(__dirname, 'allocation', 'worker.js'),
      {
        name: 'dd-allocation-profiler',
        execArgv: [],
        env: workerEnv,
      }
    )

    this.#worker.on('error', (err) => {
      this.#log('error', 'Allocation profiler worker error: %s', err.message)
      this.#disable()
    })

    this.#worker.once('exit', (code) => {
      if (this.#started) {
        this.#log('error', 'Allocation profiler worker exited unexpectedly with code %d', code)
        this.#disable()
      }
    })

    this.#worker.unref()

    this.#worker.on('message', (msg) => this.#onWorkerMessage(msg))

    this.#started = true
  }

  /**
   * Synchronously request the worker to stop tracking and prepare a profile.
   * Returns a token function for use with encode(), or null if no window is active.
   *
   * @param {boolean} restart - Whether to restart tracking after collection
   * @param {Date} startDate - Profile period start
   * @param {Date} endDate - Profile period end
   * @returns {Function|null} Token function that returns Promise<Buffer>, or null
   */
  profile (restart, startDate, endDate) {
    // Return cached profile from timer-stopped window
    if (this.#cachedProfileToken) {
      const token = this.#cachedProfileToken
      this.#cachedProfileToken = undefined
      if (restart && !this.#disabled) {
        token().then(() => this.#tryStartWindow()).catch(() => {})
      }
      return token
    }

    if (!this.#started || this.#disabled || !this.#windowActive) {
      if (restart && !this.#disabled) {
        this.#tryStartWindow()
      }
      return null
    }

    this.#clearWindowTimer()
    this.#windowActive = false

    const profilePromise = new Promise((resolve, reject) => {
      this.#pendingResolve = resolve
      this.#pendingReject = reject
    })

    this.#workerSend({
      type: 'stop-and-build-profile',
      startDate: startDate.getTime(),
      endDate: endDate.getTime(),
    })

    if (restart && !this.#disabled) {
      // Schedule next window start after profile result comes back
      profilePromise.then(() => this.#tryStartWindow()).catch(() => {})
    }

    return () => profilePromise
  }

  /**
   * Encode the profile from the token returned by profile().
   *
   * @param {Function} profileToken - Token function from profile()
   * @returns {Promise<Buffer>} Encoded pprof buffer
   */
  encode (profileToken) {
    return profileToken()
  }

  /**
   * Return metadata for this profiler to include in the upload.
   *
   * @returns {object} Metadata object
   */
  getInfo () {
    return {}
  }

  /**
   * Stop tracking and shut down the worker thread.
   */
  stop () {
    if (!this.#started) return

    this.#clearWindowTimer()
    this.#clearHeapMonitor()
    this.#started = false
    this.#windowActive = false
    this.#cachedProfileToken = undefined

    if (this.#pendingReject) {
      this.#pendingReject(new Error('Profiler stopped'))
      this.#pendingResolve = undefined
      this.#pendingReject = undefined
    }

    this.#workerSend({ type: 'shutdown' })

    // Give the worker a moment to clean up, then terminate
    const w = this.#worker
    if (w) {
      this.#worker = undefined
      setTimeout(() => {
        w.terminate().catch(() => {})
      }, 500).unref()
    }
  }

  /**
   * Handle messages from the worker thread.
   *
   * @param {object} msg - Worker message
   */
  #onWorkerMessage (msg) {
    if (!msg?.type) return

    switch (msg.type) {
      case 'ready':
        this.#tryStartWindow()
        break

      case 'tracking-started':
        this.#windowActive = true
        break

      case 'profile-result':
        if (this.#pendingResolve) {
          this.#pendingResolve(msg.buffer)
          this.#pendingResolve = undefined
          this.#pendingReject = undefined
        }
        break

      case 'error':
        this.#log('error', 'Allocation profiler worker reported error: %s', msg.message)
        this.#disable()
        break
    }
  }

  /**
   * Try to start a new tracking window.
   */
  #tryStartWindow () {
    if (!this.#started || this.#disabled || this.#windowActive) return

    // Hard cap on window duration
    this.#windowTimer = setTimeout(() => {
      this.#windowTimer = undefined
      this.#stopWindowEarly()
    }, allocationDefaults.MAX_WINDOW_DURATION_MS)
    this.#windowTimer.unref()

    this.#windowStartDate = Date.now()
    this.#workerSend({ type: 'start-tracking' })
    this.#startHeapMonitor()
  }

  /**
   * Stop the active tracking window early and cache its profile token.
   * Called by the window timer or the heap monitor.
   */
  #stopWindowEarly () {
    if (!this.#windowActive) return

    this.#windowActive = false
    this.#clearHeapMonitor()

    const profilePromise = new Promise((resolve, reject) => {
      this.#pendingResolve = resolve
      this.#pendingReject = reject
    })

    this.#workerSend({
      type: 'stop-and-build-profile',
      startDate: this.#windowStartDate,
      endDate: Date.now(),
    })

    this.#cachedProfileToken = () => profilePromise
  }

  /**
   * Start polling heap usage. Stop the active window if the limit is exceeded.
   */
  #startHeapMonitor () {
    this.#heapMonitorTimer = setInterval(() => {
      const { heapUsed } = process.memoryUsage()
      if (heapUsed > this.#config.maxHeapBytes) {
        this.#log('warn', 'Allocation profiler stopping window: heap %d exceeds limit %d',
          heapUsed, this.#config.maxHeapBytes)
        // this.#clearWindowTimer()
        // this.#stopWindowEarly()
      }
    }, allocationDefaults.HEAP_MONITOR_INTERVAL_MS)
    this.#heapMonitorTimer.unref()
  }

  /**
   * Clear the window duration timer.
   */
  #clearWindowTimer () {
    if (this.#windowTimer) {
      clearTimeout(this.#windowTimer)
      this.#windowTimer = undefined
    }
  }

  /**
   * Clear the heap monitor interval.
   */
  #clearHeapMonitor () {
    if (this.#heapMonitorTimer) {
      clearInterval(this.#heapMonitorTimer)
      this.#heapMonitorTimer = undefined
    }
  }

  /**
   * Permanently disable allocation profiling for this process.
   */
  #disable () {
    this.#disabled = true
    this.#clearWindowTimer()
    this.#clearHeapMonitor()
    this.#windowActive = false
    if (this.#pendingReject) {
      this.#pendingReject(new Error('Allocation profiler worker failed'))
      this.#pendingResolve = undefined
      this.#pendingReject = undefined
    }
    this.#log('warn', 'Allocation profiling disabled due to worker failure')
  }

  /**
   * Send a message to the worker thread.
   *
   * @param {object} msg - Message to send
   */
  #workerSend (msg) {
    if (this.#worker) {
      this.#worker.postMessage(msg)
    }
  }

  /**
   * Log a message using the configured logger.
   *
   * @param {string} level - Log level
   * @param {...unknown} args - Log arguments
   */
  #log (level, ...args) {
    if (this.#logger?.[level]) {
      this.#logger[level](...args)
    }
  }
}

module.exports = AllocationProfiler
