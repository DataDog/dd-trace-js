'use strict'

const { readFile } = require('fs')
const { types } = require('util')
const { join } = require('path')
const { Worker, MessageChannel, threadId: parentThreadId } = require('worker_threads')
const dc = require('dc-polyfill')
const log = require('../log')
const { fetchAgentInfo } = require('../agent/info')
const telemetryMetrics = require('../telemetry/metrics')
const getDebuggerConfig = require('./config')
const {
  DEBUGGER_DIAGNOSTICS_V1,
  DEBUGGER_INPUT_DIRECT,
  DEBUGGER_INPUT_V2,
  INSPECT_SEGMENT_GLOBAL_PROPERTY,
} = require('./constants')
const { GuardrailMetrics, TELEMETRY_NAMESPACE } = require('./guardrail-metrics')
const { installProbeSampler, uninstallProbeSampler } = require('./probe_sampler')

/**
 * @typedef {ReturnType<import('../config')>} Config
 */

/**
 * @typedef {import('../remote_config')} RemoteConfig
 */

// Guardrail counters are aggregated in shared memory and only converted into telemetry metrics at this interval, so
// the interval bounds the delay before a guardrail hit becomes visible, not the cost of recording it.
const GUARDRAIL_METRICS_FLUSH_INTERVAL_MS = 10_000

// Published by telemetry right before it sends its final metrics on process exit. The flush interval timer is unref'ed
// and the worker does not keep the process alive, so without this hook everything counted since the last tick would
// be lost when the application exits on its own.
const TELEMETRY_APP_CLOSING_CHANNEL = 'datadog:telemetry:app-closing'

let worker = null
let configChannel = null
let ackId = 0
let rcAckCallbacks = null
let rc = null
let inputPath = null
/** @type {GuardrailMetrics | null} */
let guardrailMetrics = null
let guardrailMetricsTimer = null

// eslint-disable-next-line eslint-rules/eslint-process-env
const { NODE_OPTIONS, ...env } = process.env

module.exports = {
  isStarted,
  start,
  configure,
  stop,
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
 * @param {Config} config - The tracer configuration object
 * @param {RemoteConfig} rcInstance - The RemoteConfig instance
 */
function start (config, rcInstance) {
  if (worker !== null) return
  if (config.DD_AGENTLESS_ENABLED && getDebuggerConfig(config) === undefined) {
    log.error('[debugger] Invalid DD_SITE for agentless Dynamic Instrumentation: %s', config.site)
    return
  }

  log.debug('[debugger] Starting Dynamic Instrumentation client...')

  rc = rcInstance
  rcAckCallbacks = new Map()
  const probeChannel = new MessageChannel()
  const logChannel = new MessageChannel()
  configChannel = new MessageChannel()

  const debuggerGlobals = globalThis[Symbol.for('dd-trace')]
  debuggerGlobals.utilTypes = types
  debuggerGlobals[INSPECT_SEGMENT_GLOBAL_PROPERTY] = require('./inspect-segment')

  const guardrailMetricsBuffer = GuardrailMetrics.createBuffer()
  guardrailMetrics = new GuardrailMetrics(guardrailMetricsBuffer)
  guardrailMetricsTimer = setInterval(flushGuardrailMetrics, GUARDRAIL_METRICS_FLUSH_INTERVAL_MS)
  guardrailMetricsTimer.unref?.()
  dc.subscribe(TELEMETRY_APP_CLOSING_CHANNEL, flushGuardrailMetrics)

  const probeSamplerBuffer = installProbeSampler(guardrailMetrics)

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

  detectDebuggerEndpoint(config, (_inputPath) => {
    inputPath = _inputPath

    worker = new Worker(
      join(__dirname, 'devtools_client', 'index.js'),
      {
        name: 'dd-debugger',
        execArgv: [], // Avoid worker thread inheriting the `-r` command line argument
        env, // Avoid worker thread inheriting the `NODE_OPTIONS` environment variable (in case it contains `-r`)
        workerData: {
          config: getDebuggerConfig(config, inputPath),
          parentThreadId,
          probePort: probeChannel.port1,
          logPort: logChannel.port1,
          configPort: configChannel.port1,
          probeSamplerBuffer,
          guardrailMetricsBuffer,
        },
        transferList: [probeChannel.port1, logChannel.port1, configChannel.port1],
      }
    )

    worker.on('online', () => {
      log.debug(
        '[debugger] Dynamic Instrumentation worker thread started successfully (thread id: %d)',
        worker.threadId
      )
    })

    worker.on('error', (err) => log.error('[debugger] worker thread error', err))
    worker.on('messageerror', (err) => log.error('[debugger] received "messageerror" from worker', err))

    worker.once('exit', (code) => {
      const error = new Error(`Dynamic Instrumentation worker thread exited unexpectedly with code ${code}`)
      log.error('[debugger] worker thread exited unexpectedly', error)
      cleanup(error) // Be nice, clean up now that the worker thread encountered an issue and we can't continue
    })

    worker.unref?.()
    probeChannel.port1.unref?.()
    probeChannel.port2.unref?.()
    logChannel.port1.unref?.()
    logChannel.port2.unref?.()
    configChannel.port1.unref?.()
    configChannel.port2.unref?.()
  })
}

/**
 * Reconfigure the Debugger worker with updated settings.
 * Sends the new configuration to the worker thread via the config channel.
 * Does nothing if the worker is not started.
 *
 * @param {import('../config/config-base')} config - The updated tracer configuration object
 */
function configure (config) {
  if (configChannel === null) return
  const debuggerConfig = getDebuggerConfig(config, inputPath)
  if (debuggerConfig === undefined) {
    log.error('[debugger] Invalid DD_SITE for agentless Dynamic Instrumentation: %s', config.site)
    return
  }
  configChannel.port2.postMessage(debuggerConfig)
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
  uninstallProbeSampler()
  configChannel = null
  inputPath = null

  if (guardrailMetricsTimer !== null) {
    clearInterval(guardrailMetricsTimer)
    guardrailMetricsTimer = null
  }
  if (guardrailMetrics !== null) {
    dc.unsubscribe(TELEMETRY_APP_CLOSING_CHANNEL, flushGuardrailMetrics)
    flushGuardrailMetrics() // Report what the worker counted up until it was stopped
    guardrailMetrics = null
  }

  // Call any pending ack callbacks
  // Pass error for unexpected exits, or undefined for graceful shutdown
  if (rcAckCallbacks) {
    for (const ackId of rcAckCallbacks.keys()) {
      const acknowledge = rcAckCallbacks.get(ackId)
      acknowledge(error)
      rcAckCallbacks.delete(ackId)
    }
    rcAckCallbacks = null
  }
}

/**
 * Convert the guardrail counters accumulated by the probe sampler and the worker into telemetry metrics.
 */
function flushGuardrailMetrics () {
  if (guardrailMetrics === null) return
  const namespace = telemetryMetrics.manager.namespace(TELEMETRY_NAMESPACE)
  guardrailMetrics.drain((metric, tags, count) => {
    namespace.count(metric, tags).inc(count)
  })
}

/**
 * Detect which debugger endpoint is available on the agent
 *
 * @param {Config} config - The tracer configuration object
 * @param {(endpointPath: string) => void} cb - Callback with the detected endpoint path
 */
function detectDebuggerEndpoint (config, cb) {
  if (config.DD_AGENTLESS_ENABLED) {
    cb(DEBUGGER_INPUT_DIRECT)
    return
  }

  log.debug('[debugger] Detecting available debugger endpoints...')

  fetchAgentInfo(config.url, (err, agentInfo) => {
    if (err) {
      log.warn('[debugger] Failed to query agent %s endpoint, falling back to %s',
        DEBUGGER_INPUT_V2,
        DEBUGGER_DIAGNOSTICS_V1,
        err)
      return cb(DEBUGGER_DIAGNOSTICS_V1)
    }

    const endpoints = agentInfo.endpoints || []

    if (endpoints.includes(DEBUGGER_INPUT_V2)) {
      log.debug('[debugger] Agent supports %s', DEBUGGER_INPUT_V2)
      return cb(DEBUGGER_INPUT_V2)
    }
    log.debug('[debugger] Agent does not support %s, using %s', DEBUGGER_INPUT_V2, DEBUGGER_DIAGNOSTICS_V1)
    return cb(DEBUGGER_DIAGNOSTICS_V1)
  })
}

/**
 * Read and parse a probe configuration file.
 * Reads the file from disk, parses it as JSON, and invokes the callback with the parsed probes.
 * Does nothing if no path is provided. Errors are logged but do not invoke the callback.
 *
 * @param {string | undefined} path - Path to the probe configuration file
 * @param {(probes: unknown[]) => void} cb - Callback invoked with the parsed probe array
 */
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
