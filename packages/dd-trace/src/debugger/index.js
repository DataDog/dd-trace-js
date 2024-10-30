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

  log.debug('Starting Dynamic Instrumentation client...')

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
      log.error(`Received an unknown ackId: ${ackId}`)
      if (error) log.error(error)
      return
    }
    ack(error)
    rcAckCallbacks.delete(ackId)
  })
  rcChannel.port2.on('messageerror', (err) => log.error(err))

  worker = new Worker(
    join(__dirname, 'devtools_client', 'index.js'),
    {
      execArgv: [], // Avoid worker thread inheriting the `-r` command line argument
      env, // Avoid worker thread inheriting the `NODE_OPTIONS` environment variable (in case it contains `-r`)
      workerData: {
        config: serializableConfig(config),
        parentThreadId,
        rcPort: rcChannel.port1,
        configPort: configChannel.port1
      },
      transferList: [rcChannel.port1, configChannel.port1]
    }
  )

  worker.unref()

  worker.on('online', () => {
    log.debug(`Dynamic Instrumentation worker thread started successfully (thread id: ${worker.threadId})`)
  })

  worker.on('error', (err) => log.error(err))
  worker.on('messageerror', (err) => log.error(err))

  worker.on('exit', (code) => {
    const error = new Error(`Dynamic Instrumentation worker thread exited unexpectedly with code ${code}`)

    log.error(error)

    // Be nice, clean up now that the worker thread encounted an issue and we can't continue
    rc.removeProductHandler('LIVE_DEBUGGING')
    worker.removeAllListeners()
    configChannel = null
    for (const ackId of rcAckCallbacks.keys()) {
      rcAckCallbacks.get(ackId)(error)
      rcAckCallbacks.delete(ackId)
    }
  })
}

function configure (config) {
  if (configChannel === null) return
  configChannel.port2.postMessage(serializableConfig(config))
}

// TODO: Refactor the Config class so it never produces any config objects that are incompatible with MessageChannel
function serializableConfig (config) {
  // URL objects cannot be serialized over the MessageChannel, so we need to convert them to strings first
  if (config.url instanceof URL) {
    config = { ...config }
    config.url = config.url.toString()
  }

  return config
}
