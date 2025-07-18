'use strict'

const { readFile } = require('fs')
const { types } = require('util')
const { join } = require('path')
const { Worker, MessageChannel, threadId: parentThreadId } = require('worker_threads')
const getDebuggerConfig = require('./config')
const log = require('../log')

let worker = null
let configChannel = null
let ackId = 0

// eslint-disable-next-line eslint-rules/eslint-process-env
const { NODE_OPTIONS, ...env } = process.env

module.exports = {
  start,
  configure
}

function start (config, rc) {
  if (worker !== null) return

  log.debug('[debugger] Starting Dynamic Instrumentation client...')

  const rcAckCallbacks = new Map()
  const probeChannel = new MessageChannel()
  const logChannel = new MessageChannel()
  configChannel = new MessageChannel()

  process[Symbol.for('datadog:node:util:types')] = types

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

  worker.on('exit', (code) => {
    const error = new Error(`Dynamic Instrumentation worker thread exited unexpectedly with code ${code}`)

    log.error('[debugger] worker thread exited unexpectedly', error)

    // Be nice, clean up now that the worker thread encounted an issue and we can't continue
    rc.removeProductHandler('LIVE_DEBUGGING')
    worker.removeAllListeners()
    configChannel = null
    for (const ackId of rcAckCallbacks.keys()) {
      rcAckCallbacks.get(ackId)(error)
      rcAckCallbacks.delete(ackId)
    }
  })

  worker.unref()
  probeChannel.port1.unref()
  probeChannel.port2.unref()
  logChannel.port1.unref()
  logChannel.port2.unref()
  configChannel.port1.unref()
  configChannel.port2.unref()
}

function configure (config) {
  if (configChannel === null) return
  configChannel.port2.postMessage(getDebuggerConfig(config))
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
