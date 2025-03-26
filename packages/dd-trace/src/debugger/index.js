'use strict'

const { join } = require('path')
const { Worker, MessageChannel, threadId: parentThreadId } = require('worker_threads')
const log = require('../log')

let worker = null
let configChannel = null
let ackId = 0

const { NODE_OPTIONS, ...env } = process.env

module.exports = {
  start,
  configure
}

function start (config, rc) {
  if (worker !== null) return

  log.debug('[debugger] Starting Dynamic Instrumentation client...')

  const rcAckCallbacks = new Map()
  const rcChannel = new MessageChannel()
  configChannel = new MessageChannel()

  rc.setProductHandler('LIVE_DEBUGGING', (action, conf, id, ack) => {
    rcAckCallbacks.set(++ackId, ack)
    rcChannel.port2.postMessage({ action, conf, ackId })
  })

  rcChannel.port2.on('message', ({ ackId, error }) => {
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
  rcChannel.port2.on('messageerror', (err) => log.error('[debugger] received "messageerror" on RC port', err))

  worker = new Worker(
    join(__dirname, 'devtools_client', 'index.js'),
    {
      execArgv: [], // Avoid worker thread inheriting the `-r` command line argument
      env, // Avoid worker thread inheriting the `NODE_OPTIONS` environment variable (in case it contains `-r`)
      workerData: {
        config: config.serialize(),
        parentThreadId,
        rcPort: rcChannel.port1,
        configPort: configChannel.port1
      },
      transferList: [rcChannel.port1, configChannel.port1]
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
  rcChannel.port1.unref()
  rcChannel.port2.unref()
  configChannel.port1.unref()
  configChannel.port2.unref()
}

function configure (config) {
  if (configChannel === null) return
  configChannel.port2.postMessage(config.serialize())
}
