'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { channel } = require('../../src/helpers/instrument')
const instrumentations = require('../../src/helpers/instrumentations')
const {
  CONFIGURATION_REQUEST,
  CONFIGURATION_RESPONSE,
  WEBDRIVERIO_WORKER_ENV,
  WEBDRIVERIO_WORKER_EVENT,
  WEBDRIVERIO_WORKER_ORIGIN,
} = require('../../src/mocha/webdriverio-protocol')

process.env[WEBDRIVERIO_WORKER_ENV] = 'true'
const existingMochaHookCount = instrumentations.mocha?.length || 0
require('../../src/mocha/worker')

const webdriverioMochaHooks = instrumentations.mocha.slice(existingMochaHookCount)
const mochaHook = webdriverioMochaHooks.find(
  ({ filePattern }) => filePattern === String.raw`lib/mocha\.(?:c?js)$`
)
const runnerHook = webdriverioMochaHooks.find(
  ({ filePattern }) => filePattern === String.raw`lib/runner\.(?:c?js)$`
)

assert.ok(mochaHook)
assert.ok(runnerHook)

const workerFinishCh = channel('ci:mocha:worker:finish')
const workerConfigurationCh = channel('ci:mocha:worker:configuration')
let workerTestFramework

function onWorkerFinish () {}
function onWorkerConfiguration ({ testFramework }) {
  workerTestFramework = testFramework
}

workerFinishCh.subscribe(onWorkerFinish)
workerConfigurationCh.subscribe(onWorkerConfiguration)

/**
 * Exercises worker-ready and suite-finish messages.
 *
 * @returns {void}
 */
function exerciseWorkerMessages () {
  class FakeMocha {
    constructor () {
      this.files = []
      this.options = {}
      this.suite = {
        run () {},
      }
    }

    /**
     * @returns {object}
     */
    run () {
      return {}
    }
  }

  class FakeRunner extends EventEmitter {
    constructor () {
      super()
      this.failures = 0
      this.suite = {
        eachTest () {},
      }
    }

    /**
     * @returns {void}
     */
    runTests () {}

    /**
     * @returns {void}
     */
    run () {
      this.emit('fail', { file: 'hook-fail.e2e.js', type: 'hook' })
      this.emit('end')
    }
  }

  mochaHook.hook(FakeMocha, '10.8.2')
  runnerHook.hook(FakeRunner)
  new FakeMocha().run()
  new FakeRunner().run()
}

let sendCalls = 0
process.connected = false
process.send = () => {
  sendCalls++
  throw new Error('send called after disconnect')
}

exerciseWorkerMessages()
assert.strictEqual(sendCalls, 0)

process.connected = true
process.send = (message, onDone) => {
  sendCalls++
  assert.strictEqual(message.origin, WEBDRIVERIO_WORKER_ORIGIN)
  assert.strictEqual(message.name, WEBDRIVERIO_WORKER_EVENT)
  assert.ok(message.args)
  assert.strictEqual(typeof onDone, 'function')
  onDone(new Error('IPC channel closed during send'))
}

exerciseWorkerMessages()
assert.strictEqual(sendCalls, 3)

process.send = (message, onDone) => {
  sendCalls++
  assert.strictEqual(message.origin, WEBDRIVERIO_WORKER_ORIGIN)
  assert.strictEqual(message.name, WEBDRIVERIO_WORKER_EVENT)
  assert.ok(message.args)
  assert.strictEqual(typeof onDone, 'function')
  onDone()
  if (message.args.name === CONFIGURATION_REQUEST) {
    process.emit('message', {
      name: CONFIGURATION_RESPONSE,
      content: {
        configuration: {
          testFramework: 'webdriverio',
        },
        requestId: message.args.content.requestId,
      },
    })
  }
}

exerciseWorkerMessages()
assert.strictEqual(sendCalls, 6)
assert.strictEqual(workerTestFramework, 'webdriverio')

workerFinishCh.unsubscribe(onWorkerFinish)
workerConfigurationCh.unsubscribe(onWorkerConfiguration)
