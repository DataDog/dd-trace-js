'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const dc = require('dc-polyfill')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

require('./setup/core')

describe('esm-module-load', () => {
  const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')
  const port2 = {}

  let port1
  let published
  let esmModuleLoad

  function onModuleLoadStart ({ filename }) {
    published.push(filename)
  }

  beforeEach(() => {
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
  })

  it('hands the loader thread a transferable port that does not keep the process alive', () => {
    assert.deepStrictEqual(esmModuleLoad.getLoaderRegisterOptions(), {
      data: { moduleLoadPort: port2 },
      transferList: [port2],
    })
    sinon.assert.calledOnce(port1.unref)
  })

  it('publishes the loader thread reports as they arrive', () => {
    esmModuleLoad.getLoaderRegisterOptions()

    port1.emit('message', 'file:///app/node_modules/axios/index.js')
    port1.emit('message', 'file:///app/node_modules/nanoid/index.js')

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

    assert.deepStrictEqual(published, [])
    assert.deepStrictEqual(esmModuleLoad.getPublishedModuleLoads(), [
      'file:///app/node_modules/nanoid/index.js',
      'file:///app/node_modules/axios/index.js',
    ])
  })
})
