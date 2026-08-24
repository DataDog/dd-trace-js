'use strict'

const { ChildProcess } = require('node:child_process')
const { BroadcastChannel } = require('node:worker_threads')

const shimmer = require('../../datadog-shimmer')
const log = require('./log')

const BROADCAST_CHANNEL_NAME = 'datadog:microvm:identity:refresh'
const INTERNAL_MESSAGE_COMMAND = 'NODE_DD_TRACE_MICROVM_IDENTITY_REFRESH'
const INTERNAL_MESSAGE = { cmd: INTERNAL_MESSAGE_COMMAND }

const childProcesses = new Set()

let broadcastChannel
let localRefresh
let parentMessageSubscribed = false
let refreshed = false

/**
 * @param {() => void} refresh
 */
function start (refresh) {
  localRefresh = refresh
  broadcastChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME)
  broadcastChannel.unref?.()
  broadcastChannel.addEventListener('message', onWorkerMessage)

  if (typeof process.send === 'function') {
    parentMessageSubscribed = true
    process.on('internalMessage', onParentMessage)
  }

  // Built-in modules cannot be source-rewritten, and Node 22 has no diagnostics event carrying
  // the ChildProcess returned by spawn, fork, and cluster.
  shimmer.wrap(ChildProcess.prototype, 'spawn', wrapChildProcessSpawn)
}

function refresh () {
  refreshIdentity(true)
}

/**
 * @param {typeof ChildProcess.prototype.spawn} spawn
 */
function wrapChildProcessSpawn (spawn) {
  /**
   * @this {ChildProcess}
   * @param {{ file: string }} options
   */
  return function spawnWithIdentityPropagation (options) {
    const result = spawn.call(this, options)

    if (!refreshed && options.file === process.execPath && this.connected) {
      trackChildProcess(this)
    }

    return result
  }
}

/**
 * @param {ChildProcess} childProcess
 */
function trackChildProcess (childProcess) {
  childProcesses.add(childProcess)

  const forgetChildProcess = () => {
    childProcesses.delete(childProcess)
  }

  childProcess.once('close', forgetChildProcess)
  childProcess.once('disconnect', forgetChildProcess)
}

/**
 * @param {MessageEvent<string>} event
 */
function onWorkerMessage (event) {
  if (event.data === INTERNAL_MESSAGE_COMMAND) {
    refreshIdentity(false)
  }
}

/**
 * @param {{ cmd?: string }} message
 */
function onParentMessage (message) {
  if (message?.cmd === INTERNAL_MESSAGE_COMMAND) {
    refreshIdentity(true)
  }
}

/**
 * @param {boolean} broadcastToWorkers
 */
function refreshIdentity (broadcastToWorkers) {
  refreshed = true
  localRefresh()

  if (broadcastToWorkers) {
    broadcastChannel.postMessage(INTERNAL_MESSAGE_COMMAND)
  }
  broadcastChannel.removeEventListener('message', onWorkerMessage)

  if (parentMessageSubscribed) {
    parentMessageSubscribed = false
    process.off('internalMessage', onParentMessage)
  }

  for (const childProcess of childProcesses) {
    if (childProcess.connected) {
      childProcess.send(INTERNAL_MESSAGE, onChildMessageSent)
    }
  }
  childProcesses.clear()
}

/**
 * @param {Error | null} error
 */
function onChildMessageSent (error) {
  if (error) {
    log.debug('Could not propagate the MicroVM identity refresh to a child process: %s', error.message)
  }
}

module.exports = { start, refresh }
