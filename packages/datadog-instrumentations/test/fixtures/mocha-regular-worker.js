'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { channel } = require('../../src/helpers/instrument')
const instrumentations = require('../../src/helpers/instrumentations')
const { WEBDRIVERIO_WORKER_ENV } = require('../../src/mocha/webdriverio-protocol')

delete process.env[WEBDRIVERIO_WORKER_ENV]

const existingMochaHookCount = instrumentations.mocha?.length || 0
require('../../src/mocha/worker')

const runnerHook = instrumentations.mocha
  .slice(existingMochaHookCount)
  .find(({ filePattern }) => filePattern === String.raw`lib/runner\.(?:c?js)$`)

assert.ok(runnerHook)

const workerFinishCh = channel('ci:mocha:worker:finish')

function onWorkerFinish () {}

workerFinishCh.subscribe(onWorkerFinish)

class FakeRunner extends EventEmitter {
  constructor () {
    super()
    this.suite = {
      eachTest () {},
    }
  }

  runTests () {}

  run () {}
}

runnerHook.hook(FakeRunner)
const runner = new FakeRunner()
runner.run()

assert.strictEqual(runner.listenerCount('fail'), 1)

workerFinishCh.unsubscribe(onWorkerFinish)
