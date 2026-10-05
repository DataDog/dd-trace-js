'use strict'

/** @typedef {typeof import('../constants').WORKER_ERROR_REASON} WorkerErrorReasons */

/**
 * @param {string} message - The error message
 * @param {WorkerErrorReasons[keyof WorkerErrorReasons]} reason - The failure reason reported in telemetry
 * @returns {Error & { reason: WorkerErrorReasons[keyof WorkerErrorReasons] }}
 */
module.exports = function createWorkerError (message, reason) {
  return Object.assign(new Error(message), { reason })
}
