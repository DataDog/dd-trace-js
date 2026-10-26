'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const dc = require('dc-polyfill')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noPreserveCache()

require('./setup/core')

describe('esm-module-load', () => {
  const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')
  const { beforeExitHandlers } = globalThis[Symbol.for('dd-trace')]
  const port2 = {}

  let clock
  let port1
  let published
  let esmModuleLoad
  let handlersBefore

  function onModuleLoadStart ({ filename }) {
    published.push(filename)
  }

  function runAddedBeforeExitHandlers () {
    for (const handler of beforeExitHandlers) {
      if (!handlersBefore.has(handler)) handler()
    }
  }

  beforeEach(() => {
    handlersBefore = new Set(beforeExitHandlers)
    clock = sinon.useFakeTimers()
    published = []
    moduleLoadStartChannel.subscribe(onModuleLoadStart)

    port1 = Object.assign(new EventEmitter(), { unref: sinon.spy() })
    class MessageChannel {
      port1 = port1
      port2 = port2
    }
    esmModuleLoad = proxyquire('../src/esm-module-load', {
      'node:worker_threads': { MessageChannel },
    })
  })

  afterEach(() => {
    moduleLoadStartChannel.unsubscribe(onModuleLoadStart)
    clock.restore()
    for (const handler of beforeExitHandlers) {
      if (!handlersBefore.has(handler)) beforeExitHandlers.delete(handler)
    }
  })

  it('hands the loader thread a transferable port that does not keep the process alive', () => {
    assert.deepStrictEqual(esmModuleLoad.getLoaderRegisterOptions(), {
      data: { moduleLoadPort: port2 },
      transferList: [port2],
    })
    sinon.assert.calledOnce(port1.unref)
  })

  it('publishes the loader thread reports together once the flush delay elapses', () => {
    esmModuleLoad.getLoaderRegisterOptions()

    port1.emit('message', 'file:///app/node_modules/axios/index.js')
    port1.emit('message', 'file:///app/node_modules/nanoid/index.js')

    clock.tick(99)
    assert.deepStrictEqual(published, [])

    clock.tick(1)
    assert.deepStrictEqual(published, [
      'file:///app/node_modules/axios/index.js',
      'file:///app/node_modules/nanoid/index.js',
    ])
  })

  it('publishes pending reports before the process exits', () => {
    esmModuleLoad.getLoaderRegisterOptions()

    port1.emit('message', 'file:///app/node_modules/nanoid/index.js')
    runAddedBeforeExitHandlers()

    assert.deepStrictEqual(published, ['file:///app/node_modules/nanoid/index.js'])

    // The flush cancelled the pending timer, so nothing is published twice.
    clock.tick(100)
    assert.deepStrictEqual(published, ['file:///app/node_modules/nanoid/index.js'])
  })

  it('starts a new batch for reports that arrive after a flush', () => {
    esmModuleLoad.getLoaderRegisterOptions()

    port1.emit('message', 'file:///app/node_modules/axios/index.js')
    clock.tick(100)
    port1.emit('message', 'file:///app/node_modules/nanoid/index.js')

    clock.tick(99)
    assert.deepStrictEqual(published, ['file:///app/node_modules/axios/index.js'])

    clock.tick(1)
    assert.deepStrictEqual(published, [
      'file:///app/node_modules/axios/index.js',
      'file:///app/node_modules/nanoid/index.js',
    ])
  })

  it('publishes synchronous loader reports immediately', () => {
    esmModuleLoad.publishModuleLoad('file:///app/node_modules/nanoid/index.js')

    assert.deepStrictEqual(published, ['file:///app/node_modules/nanoid/index.js'])
  })

  it('keeps the reports published before anyone subscribes for late consumers', () => {
    moduleLoadStartChannel.unsubscribe(onModuleLoadStart)
    esmModuleLoad.getLoaderRegisterOptions()

    esmModuleLoad.publishModuleLoad('file:///app/node_modules/nanoid/index.js')
    port1.emit('message', 'file:///app/node_modules/axios/index.js')
    clock.tick(100)

    assert.deepStrictEqual(published, [])
    assert.deepStrictEqual(esmModuleLoad.getPublishedModuleLoads(), [
      'file:///app/node_modules/nanoid/index.js',
      'file:///app/node_modules/axios/index.js',
    ])
  })
})
