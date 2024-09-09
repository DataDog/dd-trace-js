'use strict'

const { join } = require('path')
const { Worker, MessageChannel } = require('worker_threads')
const log = require('../log')

let worker = null
let configChannel = null

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
    const ackId = `${id}-${conf.version}`
    rcAckCallbacks.set(ackId, ack)
    rcChannel.port2.postMessage({ action, conf, ackId })
  })

  rcChannel.port2.on('message', ({ ackId, error }) => {
    rcAckCallbacks.get(ackId)(error)
    rcAckCallbacks.delete(ackId)
  })

  worker = new Worker(
    join(__dirname, 'devtools_client', 'index.js'),
    {
      execArgv: [], // Avoid worker thread inheriting the `-r` command line argument
      workerData: { config, rcPort: rcChannel.port1, configPort: configChannel.port1 },
      transferList: [rcChannel.port1, configChannel.port1]
    }
  )

  worker.unref()

  worker.on('online', () => {
    log.debug(`Dynamic Instrumentation worker thread started successfully (thread id: ${worker.threadId})`)
  })

  worker.on('error', (err) => log.error(err))

  worker.on('exit', (code) => {
    log.error(`Dynamic Instrumentation worker thread exited unexpectedly with code ${code}`)
  })
}

function configure (config) {
  if (configChannel === null) return
  configChannel.port2.postMessage(config)
}
