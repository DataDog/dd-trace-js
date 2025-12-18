'use strict'

const { readFile } = require('fs')
const { types } = require('util')
const { join } = require('path')
const { Worker, MessageChannel, threadId: parentThreadId } = require('worker_threads')
const log = require('../log')
const getDebuggerConfig = require('./config')

let worker = null
let configChannel = null
let ackId = 0
let rcAckCallbacks = null
let rc = null

// eslint-disable-next-line eslint-rules/eslint-process-env
const { NODE_OPTIONS, ...env } = process.env

module.exports = {
  isStarted,
  start,
  configure,
  stop
}

/**
 * Check if the Debugger worker is currently running
 *
 * @returns {boolean} True if the worker is started, false otherwise
 */
function isStarted () {
  return worker !== null
}

/**
 * Start the Debugger worker thread.
 * Creates a worker thread, sets up message channels, and registers
 * the LIVE_DEBUGGING product handler with remote config.
 * Does nothing if the worker is already started.
 *
 * @param {Object} config - The tracer configuration object
 * @param {Object} rcInstance - The RemoteConfig instance
 */
function start (config, rcInstance) {
  if (worker !== null) return

  log.debug('[debugger] Starting Dynamic Instrumentation client...')

  rc = rcInstance
  rcAckCallbacks = new Map()
  const probeChannel = new MessageChannel()
  const logChannel = new MessageChannel()
  configChannel = new MessageChannel()

  globalThis[Symbol.for('dd-trace')].utilTypes = types

  readProbeFile(config.dynamicInstrumentation.probeFile, (probes) => {
    const action = 'apply'
    for (const probe of probes) {
      probeChannel.port2.postMessage({ action, probe })
    }
  })

  rc.setProductHandler('LIVE_DEBUGGING', (action, probe, id, ack) => {
    rcAckCallbacks.set(++ackId, ack)
    probeChannel.port2.postMessage({ action, probe, ackId })
  })

  probeChannel.port2.on('message', ({ ackId, error }) => {
    const ack = rcAckCallbacks.get(ackId)
    if (ack === undefined) {
      // This should never happen, but just in case something changes in the future, we should guard against it
      log.error('[debugger] Received an unknown ackId: %s', ackId)
      if (error) log.error('[debugger] Error starting Dynamic Instrumentation client', error)
      return
    }
    ack(error)
    rcAckCallbacks.delete(ackId)
  })
  probeChannel.port2.on('messageerror', (err) => log.error('[debugger] received "messageerror" on probe port', err))

  logChannel.port2.on('message', ({ level, args }) => {
    log[level](...args)
  })
  logChannel.port2.on('messageerror', (err) => log.error('[debugger] received "messageerror" on log port', err))

  worker = new Worker(
    join(__dirname, 'devtools_client', 'index.js'),
    {
      execArgv: [], // Avoid worker thread inheriting the `-r` command line argument
      env, // Avoid worker thread inheriting the `NODE_OPTIONS` environment variable (in case it contains `-r`)
      workerData: {
        config: getDebuggerConfig(config),
        parentThreadId,
        probePort: probeChannel.port1,
        logPort: logChannel.port1,
        configPort: configChannel.port1
      },
      transferList: [probeChannel.port1, logChannel.port1, configChannel.port1]
    }
  )

  worker.on('online', () => {
    log.debug('[debugger] Dynamic Instrumentation worker thread started successfully (thread id: %d)', worker.threadId)
  })

  worker.on('error', (err) => log.error('[debugger] worker thread error', err))
  worker.on('messageerror', (err) => log.error('[debugger] received "messageerror" from worker', err))

  worker.once('exit', (code) => {
    const error = new Error(`Dynamic Instrumentation worker thread exited unexpectedly with code ${code}`)
    log.error('[debugger] worker thread exited unexpectedly', error)
    cleanup(error) // Be nice, clean up now that the worker thread encountered an issue and we can't continue
  })

  worker.unref()
  probeChannel.port1.unref()
  probeChannel.port2.unref()
  logChannel.port1.unref()
  logChannel.port2.unref()
  configChannel.port1.unref()
  configChannel.port2.unref()
}

/**
 * Reconfigure the Debugger worker with updated settings.
 * Sends the new configuration to the worker thread via the config channel.
 * Does nothing if the worker is not started.
 *
 * @param {Object} config - The updated tracer configuration object
 */
function configure (config) {
  if (configChannel === null) return
  configChannel.port2.postMessage(getDebuggerConfig(config))
}

/**
 * Stop the Debugger worker thread.
 * Terminates the worker and cleans up resources.
 * Safe to call even if the worker is not started.
 */
function stop () {
  if (worker === null) return

  log.debug('[debugger] Stopping Dynamic Instrumentation client...')

  try {
    worker.terminate()
    cleanup() // Graceful shutdown - termination succeeded
  } catch (err) {
    log.error('[debugger] Error terminating worker', err)
    cleanup(err) // Cleanup with error - termination failed
  }
}

/**
 * Internal cleanup function to reset all debugger resources.
 * Called when stopping the debugger or when the worker exits unexpectedly.
 *
 * @param {Error} [error] - Optional error to pass to pending ack callbacks (for unexpected exits)
 */
function cleanup (error) {
  if (rc) {
    rc.removeProductHandler('LIVE_DEBUGGING')
    rc = null
  }
  if (worker) {
    worker.removeAllListeners()
    worker = null
  }
  configChannel = null

  // Call any pending ack callbacks
  // Pass error for unexpected exits, or undefined for graceful shutdown
  if (rcAckCallbacks) {
    for (const ackId of rcAckCallbacks.keys()) {
      rcAckCallbacks.get(ackId)(error)
      rcAckCallbacks.delete(ackId)
    }
    rcAckCallbacks = null
  }
}

function readProbeFile (path, cb) {
  if (!path) return

  log.debug('[debugger] Reading probe file: %s', path)
  readFile(path, 'utf8', (err, data) => {
    if (err) {
      log.error('[debugger] Failed to read probe file: %s', path, err)
      return
    }
    try {
      const parsedData = JSON.parse(data)
      log.debug('[debugger] Successfully parsed probe file: %s', path)
      cb(parsedData)
    } catch (err) {
      log.error('[debugger] Probe file (%s) is not valid JSON', path, err)
    }
  })
}
