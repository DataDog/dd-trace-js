'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const BRIDGE_CHANNEL = 'datadog:bridge-send'
const CONFIG_CHANNEL = 'datadog:bridge-config'

describe('electron/preload', () => {
  let contextBridge
  let ipcRenderer

  beforeEach(() => {
    global.location = { hostname: 'test.example.com' }
    global.window = {}

    ipcRenderer = {
      sendSync: sinon.stub(),
      send: sinon.stub(),
    }
    contextBridge = {
      exposeInMainWorld: sinon.stub(),
    }
  })

  afterEach(() => {
    delete global.location
    delete global.window
  })

  function loadPreload (config = null) {
    ipcRenderer.sendSync.returns(config)
    proxyquire('../../src/electron/preload', {
      electron: { contextBridge, ipcRenderer, '@noCallThru': true },
    })
    return global.window.DatadogEventBridge
  }

  it('requests config from main via the config channel', () => {
    loadPreload()
    sinon.assert.calledOnceWithExactly(ipcRenderer.sendSync, CONFIG_CHANNEL)
  })

  it('sets DatadogEventBridge on window', () => {
    loadPreload()
    assert.ok(global.window.DatadogEventBridge)
  })

  it('exposes DatadogEventBridge in the main world via contextBridge', () => {
    const bridge = loadPreload()
    sinon.assert.calledOnceWithExactly(contextBridge.exposeInMainWorld, 'DatadogEventBridge', bridge)
  })

  describe('getCapabilities()', () => {
    it('returns an empty JSON array', () => {
      const bridge = loadPreload()
      assert.strictEqual(bridge.getCapabilities(), '[]')
    })
  })

  describe('getPrivacyLevel()', () => {
    it('returns "mask" when no config is provided', () => {
      const bridge = loadPreload(null)
      assert.strictEqual(bridge.getPrivacyLevel(), 'mask')
    })

    it('returns "mask" when config does not include defaultPrivacyLevel', () => {
      const bridge = loadPreload({ allowedWebViewHosts: [] })
      assert.strictEqual(bridge.getPrivacyLevel(), 'mask')
    })

    it('returns the configured privacy level', () => {
      const bridge = loadPreload({ defaultPrivacyLevel: 'allow' })
      assert.strictEqual(bridge.getPrivacyLevel(), 'allow')
    })
  })

  describe('getAllowedWebViewHosts()', () => {
    it('includes location.hostname when no config is provided', () => {
      const bridge = loadPreload(null)
      const hosts = JSON.parse(bridge.getAllowedWebViewHosts())
      assert.ok(hosts.includes('test.example.com'))
    })

    it('includes both location.hostname and configured hosts', () => {
      const bridge = loadPreload({ allowedWebViewHosts: ['allowed.example.com'] })
      const hosts = JSON.parse(bridge.getAllowedWebViewHosts())
      assert.ok(hosts.includes('test.example.com'))
      assert.ok(hosts.includes('allowed.example.com'))
    })

    it('deduplicates hosts when location.hostname is also in configured hosts', () => {
      const bridge = loadPreload({ allowedWebViewHosts: ['test.example.com', 'other.example.com'] })
      const hosts = JSON.parse(bridge.getAllowedWebViewHosts())
      assert.strictEqual(hosts.filter(h => h === 'test.example.com').length, 1)
      assert.ok(hosts.includes('other.example.com'))
    })
  })

  describe('send()', () => {
    it('forwards the message to the main process via the bridge channel', () => {
      const bridge = loadPreload()
      bridge.send('{"type":"record"}')
      sinon.assert.calledOnceWithExactly(ipcRenderer.send, BRIDGE_CHANNEL, '{"type":"record"}')
    })
  })

  describe('when contextIsolation is disabled', () => {
    it('does not throw and still sets bridge on window', () => {
      contextBridge.exposeInMainWorld.throws(new Error('contextIsolation is disabled'))
      const bridge = loadPreload()
      assert.ok(bridge)
      assert.strictEqual(bridge.getCapabilities(), '[]')
    })
  })
})
