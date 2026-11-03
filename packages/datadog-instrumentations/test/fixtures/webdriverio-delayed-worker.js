'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { channel } = require('../../src/helpers/instrument')
const instrumentations = require('../../src/helpers/instrumentations')
const {
  SUITE_FINISH,
  WEBDRIVERIO_WORKER_ENV,
  WEBDRIVERIO_WORKER_EVENT,
  WEBDRIVERIO_WORKER_ORIGIN,
} = require('../../src/mocha/webdriverio-protocol')

process.env[WEBDRIVERIO_WORKER_ENV] = 'true'
const existingMochaHookCount = instrumentations.mocha?.length || 0
require('../../src/mocha/worker')

const runnerHook = instrumentations.mocha
  .slice(existingMochaHookCount)
  .find(({ filePattern }) => filePattern === String.raw`lib/runner\.(?:c?js)$`)

assert.ok(runnerHook)

const workerFinishCh = channel('ci:mocha:worker:finish')
let flushDone

function onWorkerFinish ({ onDone }) {
  flushDone = onDone
}

workerFinishCh.subscribe(onWorkerFinish)

class FakeRunner extends EventEmitter {
  constructor () {
    super()
    this.failures = 0
    this.suite = {
      eachTest () {},
    }
  }

  runTests () {}

  run (onDone) {
    this.emit('end')
    onDone()
  }
}

runnerHook.hook(FakeRunner)

let runDone = false
let suiteMessageDone
process.connected = true
process.send = (message, onDone) => {
  assert.strictEqual(message.origin, WEBDRIVERIO_WORKER_ORIGIN)
  assert.strictEqual(message.name, WEBDRIVERIO_WORKER_EVENT)
  assert.strictEqual(message.args.name, SUITE_FINISH)
  suiteMessageDone = onDone
}

new FakeRunner().run(() => {
  runDone = true
})

assert.strictEqual(runDone, false)
assert.strictEqual(typeof flushDone, 'function')
assert.strictEqual(suiteMessageDone, undefined)

flushDone()
assert.strictEqual(runDone, false)
assert.strictEqual(typeof suiteMessageDone, 'function')

suiteMessageDone()
assert.strictEqual(runDone, true)

runDone = false
flushDone = undefined
suiteMessageDone = undefined
process.connected = false

new FakeRunner().run(() => {
  runDone = true
})

assert.strictEqual(runDone, false)
assert.strictEqual(typeof flushDone, 'function')

flushDone()
assert.strictEqual(runDone, true)
assert.strictEqual(suiteMessageDone, undefined)

workerFinishCh.unsubscribe(onWorkerFinish)
