'use strict'

/**
 * @param {{ message?: string, cause?: Error, stack?: string, constructor?: Function,
 *   sendViaTelemetry?: boolean }} error
 * @returns {{ level: 'ERROR', count: number, message: string, stack_trace?: string,
 *   errorType?: string } | undefined}
 */
module.exports = function formatError (error) {
  if (!error || error.sendViaTelemetry === false) return

  const cause = error.cause ?? error
  const message = error.message ?? 'Generic Error'
  if (!message && !cause.stack) return

  const telemetryLog = {
    level: 'ERROR',
    count: 1,
    message,
  }

  if (cause.stack) {
    telemetryLog.stack_trace = cause.stack
    telemetryLog.errorType = cause.constructor.name
  }

  return telemetryLog
}
