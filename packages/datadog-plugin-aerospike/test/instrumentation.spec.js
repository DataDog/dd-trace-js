'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')

const { storage } = require('../../datadog-core')

require('../../datadog-instrumentations/src/aerospike')

const HOOK = globalThis[Symbol.for('_ddtrace_instrumentations')].aerospike
  .find(entry => entry.file === 'lib/commands/command.js')
  .hook

const commandStorage = storage('aerospike-command-test')
const commandChannel = dc.tracingChannel('apm:aerospike:command')

function wrapCommandFactory (commandFactory) {
  return HOOK(commandFactory)()
}

describe('packages/datadog-instrumentations/src/aerospike.js', () => {
  let starts
  let asyncStarts

  beforeEach(() => {
    starts = 0
    asyncStarts = 0

    commandChannel.start.bindStore(commandStorage, ctx => {
      starts++
      const parentStore = commandStorage.getStore()
      ctx.parentStore = parentStore
      ctx.currentStore = { ...parentStore, span: { name: 'aerospike-command' } }
      return ctx.currentStore
    })

    commandChannel.asyncStart.bindStore(commandStorage, ctx => {
      asyncStarts++
      return ctx.parentStore
    })
  })

  afterEach(() => {
    commandChannel.start.unbindStore(commandStorage)
    commandChannel.asyncStart.unbindStore(commandStorage)
  })

  it('runs callbacks in the parent context after Aerospike defers a synchronous result', async () => {
    const Command = wrapCommandFactory(() => class FakeCommand {
      constructor () {
        this.args = ['arg']
        this.client = { config: { hosts: '127.0.0.1:3000' } }
      }

      process (callback) {
        callback(null, 'ok')
      }

      executeWithCallback (callback) {
        let sync = true
        this.process((error, result) => {
          if (sync) {
            process.nextTick(callback, error, result)
          } else {
            callback(error, result)
          }
        })
        sync = false
      }
    })

    const parentSpan = { name: 'parent' }
    const command = new Command()

    const resultPromise = new Promise((resolve, reject) => {
      commandStorage.run({ span: parentSpan }, () => {
        command.executeWithCallback((error, value) => {
          try {
            assert.ifError(error)
            assert.equal(commandStorage.getStore()?.span, parentSpan)
            resolve(value)
          } catch (err) {
            reject(err)
          }
        })

        assert.equal(starts, 1)
        assert.equal(asyncStarts, 0)
      })
    })

    const result = await resultPromise

    assert.equal(result, 'ok')
    assert.equal(starts, 1)
    assert.equal(asyncStarts, 1)
  })

  it('still traces commands through process when no callback helper exists', async () => {
    const Command = wrapCommandFactory(() => class FakeCommand {
      constructor () {
        this.args = ['arg']
        this.client = { config: { hosts: '127.0.0.1:3000' } }
      }

      process (callback) {
        process.nextTick(callback, null, 'ok')
      }

      executeAndReturnPromise () {
        return new Promise((resolve, reject) => {
          this.process((error, result) => {
            if (error) {
              reject(error)
            } else {
              resolve(result)
            }
          })
        })
      }
    })

    const parentSpan = { name: 'parent' }
    const command = new Command()

    const result = await commandStorage.run({ span: parentSpan }, () => command.executeAndReturnPromise())

    assert.equal(result, 'ok')
    assert.equal(starts, 1)
    assert.equal(asyncStarts, 1)
  })
})
