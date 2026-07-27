'use strict'

const { once } = require('node:events')
const { join } = require('node:path')
const { isMainThread } = require('node:worker_threads')

const NativeMessageChannel = globalThis.MessageChannel
const dynamicInstrumentationPath = join('ci-visibility', 'dynamic-instrumentation', 'index.js')

let firstProbeRemovalAcknowledged
let heldProbeId
let heldProbeRemovalReleased = false
let postProbeRemoval
let probeSetAfterRelease = false

if (isMainThread) {
  globalThis.MessageChannel = class extends NativeMessageChannel {
    constructor () {
      super()

      if (!new Error().stack?.includes(dynamicInstrumentationPath)) return

      const postMessage = this.port2.postMessage.bind(this.port2)

      /**
       * @param {object|string} message
       */
      this.port2.postMessage = (message) => {
        if (heldProbeId === undefined && typeof message === 'string') {
          heldProbeId = message
          postProbeRemoval = postMessage
          firstProbeRemovalAcknowledged = once(this.port2, 'message')
        } else {
          if (heldProbeRemovalReleased && typeof message !== 'string' && message.file && message.line) {
            probeSetAfterRelease = true
          }
          postMessage(message)
        }
      }
    }
  }
}

function releaseHeldProbeRemoval () {
  if (heldProbeId === undefined) {
    throw new Error('Dynamic Instrumentation probe removal was not held')
  }
  heldProbeRemovalReleased = true
  postProbeRemoval(heldProbeId)
}

function assertNoProbeSetAfterRelease () {
  if (probeSetAfterRelease) {
    throw new Error('Dynamic Instrumentation set a canceled probe')
  }
}

function waitForFirstProbeRemoval () {
  if (!firstProbeRemovalAcknowledged) {
    throw new Error('Dynamic Instrumentation removal channel was not created')
  }
  return firstProbeRemovalAcknowledged
}

module.exports = {
  assertNoProbeSetAfterRelease,
  releaseHeldProbeRemoval,
  waitForFirstProbeRemoval,
}
