'use strict'

// Async control-plane timer for the direct-API batch processor, ported from the shim.
class Timer {
  #timer
  #promise
  #resolve
  #completed = false
  #intervalMs

  /** @param {number} intervalMs */
  constructor (intervalMs) {
    this.#intervalMs = intervalMs
  }

  start () {
    if (this.#timer !== undefined) return
    this.#timer = setInterval(() => {
      if (this.#resolve !== undefined) {
        this.#resolve(false)
        this.#resolve = undefined
        this.#promise = undefined
      }
    }, this.#intervalMs)
  }

  /** @returns {Promise<boolean>} */
  nextTimeout () {
    if (this.#completed) return Promise.resolve(true)
    if (this.#promise === undefined) {
      this.#promise = new Promise(resolve => { this.#resolve = resolve })
    }
    return this.#promise
  }

  complete () {
    this.#completed = true
    if (this.#timer !== undefined) {
      clearInterval(this.#timer)
      this.#timer = undefined
    }
    const resolve = this.#resolve
    this.#resolve = undefined
    this.#promise = undefined
    if (resolve !== undefined) resolve(true)
  }
}

module.exports = { Timer }
