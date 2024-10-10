'use strict'
const { randomUUID } = require('crypto')
const { join } = require('path')
const { Worker, MessageChannel, threadId: parentThreadId, isMainThread } = require('worker_threads')
const log = require('../log')

let worker = null
let configChannel = null

const { NODE_OPTIONS, ...env } = process.env

module.exports = {
  start,
  configure
}

function start (config, rc) {
  if (worker !== null) return

  log.warn('Starting Dynamic Instrumentation client...')

  const rcAckCallbacks = new Map()
  const rcChannel = new MessageChannel()
  configChannel = new MessageChannel()

  // rc.setProductHandler('LIVE_DEBUGGING', (action, conf, id, ack) => {
  //   const ackId = `${id}-${conf.version}`
  //   rcAckCallbacks.set(ackId, ack)
  //   rcChannel.port2.postMessage({ action, conf, ackId })
  // })

  // these on 'message' should also be unref
  rcChannel.port2.on('message', ({ ackId, error }) => {
    // rcAckCallbacks.get(ackId)(error)
    // rcAckCallbacks.delete(ackId)
  }).unref()

  rcChannel.port2.on('messageerror', (err) => log.warn(err)).unref()

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
    log.warn(`Dynamic Instrumentation worker thread started successfully (thread id: ${worker.threadId})`)
    global._shouldAddMessagePromise.then(() => {
      debugger
      rcChannel.port2.postMessage({
        action: 'apply',
        conf: {
          id: randomUUID(),
          tags: [],
          version: 0,
          captureSnapshot: true,
          language: 'javascript',
          type: 'LOG_PROBE',
          where: {
            sourceFile: 'sum.js',
            lines: ['8']
          },
          capture: { maxReferenceDepth: 3 }
        }
      })
    })
    // global._unapplyProbe = () => {
    //   rcChannel.port2.postMessage({
    //     action: 'unapply',
    //     conf: {
    //       id: '1',
    //       type: 'LOG_PROBE',
    //       where: {
    //         sourceFile: 'sum.js',
    //         lines: ['4']
    //       }
    //     }
    //   })
    // }
  })

  worker.on('error', (err) => log.warn(err))
  worker.on('messageerror', (err) => log.warn(err))

  worker.on('exit', (code) => {
    console.log('exit', code)
    const error = new Error(`Dynamic Instrumentation worker thread exited unexpectedly with code ${code}`)

    log.warn(error)

    // Be nice, clean up now that the worker thread encounted an issue and we can't continue
    // rc.removeProductHandler('LIVE_DEBUGGING')
    worker.removeAllListeners()
    configChannel = null
    for (const ackId of rcAckCallbacks.keys()) {
      // rcAckCallbacks.get(ackId)(error)
      // rcAckCallbacks.delete(ackId)
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
