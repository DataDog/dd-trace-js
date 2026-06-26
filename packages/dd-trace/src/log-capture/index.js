'use strict'

const sender = require('./sender')

/**
 * Initialize the log-capture transport: configure the sender with the
 * resolved options and register its flush hook in the beforeExit lifecycle.
 * Safe to call repeatedly — re-configuration flushes any buffered records
 * before switching, and the flush hook is registered at most once.
 *
 * @param {import('../config/config-base')} config
 */
function initializeLogCapture (config) {
  sender.configure({
    host: config.logCaptureHost,
    port: config.logCapturePort,
    path: config.logCapturePath,
    protocol: config.logCaptureProtocol,
    maxBufferSize: config.logCaptureMaxBufferSize,
    flushIntervalMs: config.logCaptureFlushIntervalMs,
    timeoutMs: config.logCaptureTimeoutMs,
  })
  const handlers = globalThis[Symbol.for('dd-trace')]?.beforeExitHandlers
  if (handlers && !handlers.has(sender.flush)) {
    handlers.add(sender.flush)
  }
}

module.exports = { initializeLogCapture }
