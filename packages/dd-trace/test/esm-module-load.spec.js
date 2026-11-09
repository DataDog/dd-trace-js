'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const dc = require('dc-polyfill')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

require('./setup/core')

describe('esm-module-load', () => {
  const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')
  const moduleLoadEndChannel = dc.channel('dd-trace:moduleLoadEnd')
  const port2 = {}

  let port1
  let events
  let esmModuleLoad

  function onModuleLoadStart ({ filename }) {
    events.push(`start ${filename}`)
  }

  function onModuleLoadEnd ({ filename }) {
    events.push(`end ${filename}`)
  }

  beforeEach(() => {
    events = []
    moduleLoadStartChannel.subscribe(onModuleLoadStart)
    moduleLoadEndChannel.subscribe(onModuleLoadEnd)

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
    moduleLoadEndChannel.unsubscribe(onModuleLoadEnd)
  })

  it('hands the loader thread a transferable port that does not keep the process alive', () => {
    assert.deepStrictEqual(esmModuleLoad.getLoaderRegisterOptions(), {
      data: { moduleLoadPort: port2 },
      transferList: [port2],
    })
    sinon.assert.calledOnce(port1.unref)
  })

  it('publishes the loader thread reports as they arrive, each start closed by an end', () => {
    esmModuleLoad.getLoaderRegisterOptions()

    port1.emit('message', 'file:///app/node_modules/axios/index.js')
    port1.emit('message', 'file:///app/node_modules/nanoid/index.js')

    assert.deepStrictEqual(events, [
      'start file:///app/node_modules/axios/index.js',
      'end file:///app/node_modules/axios/index.js',
      'start file:///app/node_modules/nanoid/index.js',
      'end file:///app/node_modules/nanoid/index.js',
    ])
  })

  it('publishes synchronous loader reports immediately, each start closed by an end', () => {
    esmModuleLoad.publishModuleLoad('file:///app/node_modules/nanoid/index.js')

    assert.deepStrictEqual(events, [
      'start file:///app/node_modules/nanoid/index.js',
      'end file:///app/node_modules/nanoid/index.js',
    ])
  })

  it('keeps the reports published before anyone subscribes for late consumers', () => {
    moduleLoadStartChannel.unsubscribe(onModuleLoadStart)
    moduleLoadEndChannel.unsubscribe(onModuleLoadEnd)
    esmModuleLoad.getLoaderRegisterOptions()

    esmModuleLoad.publishModuleLoad('file:///app/node_modules/nanoid/index.js')
    port1.emit('message', 'file:///app/node_modules/axios/index.js')

    assert.deepStrictEqual(events, [])
    assert.deepStrictEqual(esmModuleLoad.getPublishedModuleLoads(), [
      'file:///app/node_modules/nanoid/index.js',
      'file:///app/node_modules/axios/index.js',
    ])
  })
})
