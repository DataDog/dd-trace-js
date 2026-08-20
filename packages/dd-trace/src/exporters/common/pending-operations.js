'use strict'

const noop = () => {}

/**
 * @typedef {object} Waiter
 * @property {(() => void)|undefined} done
 * @property {Waiter|undefined} next
 * @property {Waiter|undefined} previous
 * @property {number} target
 */

class PendingOperations {
  #completed = 0
  /** @type {Map<number, number>} */
  #completedRangeEnds = new Map()
  /** @type {Map<number, number>} */
  #completedRangeStarts = new Map()
  /** @type {Waiter|undefined} */
  #firstWaiter
  /** @type {Waiter|undefined} */
  #lastWaiter
  #started = 0

  /**
   * Starts an operation tracked by subsequent completion boundaries.
   *
   * @returns {() => void} Completes the operation once.
   */
  start () {
    const operation = ++this.#started
    let completed = false

    return () => {
      if (completed) return
      completed = true
      this.#complete(operation)
    }
  }

  /**
   * Tracks an operation that reports completion through a callback.
   *
   * @param {(done: () => void) => void} operation
   * @param {() => void} [done]
   */
  track (operation, done) {
    const operationDone = this.start()
    let completed = false
    const complete = () => {
      if (completed) return
      completed = true
      try {
        done?.()
      } finally {
        operationDone()
      }
    }
    try {
      operation(complete)
    } catch (error) {
      complete()
      throw error
    }
  }

  /**
   * Calls back after every operation started before this boundary completes.
   *
   * @param {() => void} done
   * @returns {() => void} Detaches the callback from this boundary.
   */
  wait (done) {
    const target = this.#started
    if (target === this.#completed) {
      done()
      return noop
    }

    const waiter = { done, next: undefined, previous: this.#lastWaiter, target }
    if (this.#lastWaiter) this.#lastWaiter.next = waiter
    else this.#firstWaiter = waiter
    this.#lastWaiter = waiter

    return () => {
      if (waiter.done === undefined) return
      waiter.done = undefined
      this.#removeWaiter(waiter)
    }
  }

  /**
   * Advances the contiguous completion boundary and releases eligible waiters.
   *
   * @param {number} operation
   */
  #complete (operation) {
    if (operation !== this.#completed + 1) {
      this.#addCompletedRange(operation)
      return
    }

    this.#completed = operation
    const rangeEnd = this.#completedRangeStarts.get(operation + 1)
    if (rangeEnd !== undefined) {
      this.#completedRangeStarts.delete(operation + 1)
      this.#completedRangeEnds.delete(rangeEnd)
      this.#completed = rangeEnd
    }

    let callbacks
    let waiter = this.#firstWaiter
    while (waiter && waiter.target <= this.#completed) {
      const next = waiter.next
      const { done } = waiter
      waiter.done = undefined
      this.#removeWaiter(waiter)
      if (done) {
        callbacks ??= []
        callbacks.push(done)
      }
      waiter = next
    }

    if (this.#completed === this.#started) {
      this.#completed = 0
      this.#started = 0
    }

    if (callbacks) {
      let callbackError
      let callbackFailed = false
      for (const done of callbacks) {
        try {
          done()
        } catch (error) {
          if (!callbackFailed) callbackError = error
          callbackFailed = true
        }
      }
      if (callbackFailed) throw callbackError
    }
  }

  /**
   * Compacts an out-of-order completion into ranges separated by active operations.
   *
   * @param {number} operation
   */
  #addCompletedRange (operation) {
    const previousStart = this.#completedRangeEnds.get(operation - 1)
    const nextEnd = this.#completedRangeStarts.get(operation + 1)

    if (previousStart === undefined) {
      if (nextEnd === undefined) {
        this.#completedRangeStarts.set(operation, operation)
        this.#completedRangeEnds.set(operation, operation)
      } else {
        this.#completedRangeStarts.delete(operation + 1)
        this.#completedRangeStarts.set(operation, nextEnd)
        this.#completedRangeEnds.set(nextEnd, operation)
      }
      return
    }

    this.#completedRangeEnds.delete(operation - 1)
    if (nextEnd === undefined) {
      this.#completedRangeStarts.set(previousStart, operation)
      this.#completedRangeEnds.set(operation, previousStart)
    } else {
      this.#completedRangeStarts.delete(operation + 1)
      this.#completedRangeStarts.set(previousStart, nextEnd)
      this.#completedRangeEnds.set(nextEnd, previousStart)
    }
  }

  /**
   * @param {Waiter} waiter
   */
  #removeWaiter (waiter) {
    if (waiter.previous) waiter.previous.next = waiter.next
    else this.#firstWaiter = waiter.next

    if (waiter.next) waiter.next.previous = waiter.previous
    else this.#lastWaiter = waiter.previous

    waiter.next = undefined
    waiter.previous = undefined
  }
}

module.exports = PendingOperations
