'use strict'

/** @typedef {typeof import('../constants').WORKER_ERROR_REASON} WorkerErrorReasons */

/**
 * An error carrying a failure reason for telemetry. Its prototype does not survive the worker boundary, so the main
 * thread must read `reason` instead of checking `instanceof`. `name` is left as `Error` because structured cloning
 * only keeps built-in error names, and telemetry should report the same name however the error leaves the worker.
 */
class WorkerError extends Error {
  /**
   * @param {string} message - The error message
   * @param {WorkerErrorReasons[keyof WorkerErrorReasons]} reason - The failure reason reported in telemetry
   */
  constructor (message, reason) {
    super(message)
    this.reason = reason
  }
}

module.exports = WorkerError
