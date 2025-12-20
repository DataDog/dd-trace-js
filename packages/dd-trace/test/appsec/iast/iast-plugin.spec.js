'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const { IastPlugin } = require('../../../src/appsec/iast/iast-plugin')
const { getExecutedMetric, getInstrumentedMetric, TagKey } = require('../../../src/appsec/iast/telemetry/iast-metric')
const VULNERABILITY_TYPE = TagKey.VULNERABILITY_TYPE
const SOURCE_TYPE = TagKey.SOURCE_TYPE

describe('IAST Plugin', () => {
  const loadChannel = channel('dd-trace:instrumentation:load')

  let logError, addSubMock, getIastContext, configureMock, legacyStorage

  const handler = () => {
    throw new Error('handler error')
  }
  const channelName = 'datadog:test:start'

  let iastPlugin

  beforeEach(() => {
    addSubMock = sinon.stub()
    logError = sinon.stub()
    getIastContext = sinon.stub()
    configureMock = sinon.stub()
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('with appsec telemetry disabled', () => {
    beforeEach(() => {
      class PluginClass {
        addSub (channelName, handler) {
          addSubMock(channelName, handler)
        }

        configure (config) {
          configureMock(config)
        }
      }

      legacyStorage = {
        getStore: () => sinon.stub()
      }

      const iastPluginMod = proxyquire('../../../src/appsec/iast/iast-plugin', {
        '../../plugins/plugin': PluginClass,
        '../../log': {
          error: logError
        },
        './iast-context': {
          getIastContext
        },
        './telemetry': {
          isEnabled: () => false
        },
        '../../../../datadog-core': { storage: () => legacyStorage }
      })
      iastPlugin = new iastPluginMod.IastPlugin()
    })

    afterEach(() => {
      iastPlugin.disableTelemetry()
    })

    describe('addSub', () => {
      it('should call Plugin.addSub with channelName and handler', () => {
        iastPlugin.addSub('test', handler)

        sinon.assert.calledOnce(addSubMock)
        const args = addSubMock.getCall(0).args
        assert.strictEqual(args[0], 'test')
        assert.strictEqual(args[1], handler)
      })

      it('should call Plugin.addSub with channelName and handler after registering iastPluginSub', () => {
        const iastPluginSub = { channelName: 'test' }
        iastPlugin.addSub(iastPluginSub, handler)

        sinon.assert.calledOnce(addSubMock)
        const args = addSubMock.getCall(0).args
        assert.strictEqual(args[0], 'test')
        assert.strictEqual(args[1], handler)
      })

      it('should infer moduleName from channelName after registering iastPluginSub', () => {
        const iastPluginSub = { channelName: 'test' }
        iastPlugin.addSub(iastPluginSub, handler)

        assert.strictEqual(iastPlugin.pluginSubs.length, 1)
        assert.strictEqual(iastPlugin.pluginSubs[0].moduleName, 'test')
      })

      it('should infer moduleName from channelName after registering iastPluginSub with real channelName', () => {
        const iastPluginSub = { channelName: 'datadog:test:start' }
        iastPlugin.addSub(iastPluginSub, handler)

        assert.strictEqual(iastPlugin.pluginSubs.length, 1)
        assert.strictEqual(iastPlugin.pluginSubs[0].moduleName, 'test')
      })

      it('should not call _getTelemetryHandler', () => {
        const getTelemetryHandler = sinon.stub()
        iastPlugin._getTelemetryHandler = getTelemetryHandler
        iastPlugin.addSub({ channelName, tagKey: VULNERABILITY_TYPE }, handler)

        sinon.assert.notCalled(getTelemetryHandler)

        getTelemetryHandler.reset()

        iastPlugin.addSub({ channelName, tagKey: SOURCE_TYPE, tag: 'test-tag' }, handler)
        sinon.assert.notCalled(getTelemetryHandler)
      })
    })

    describe('configure', () => {
      it('should mark Plugin configured and call only once onConfigure', () => {
        iastPlugin.onConfigure = sinon.stub()
        iastPlugin.configure(true)
        iastPlugin.configure(false)
        iastPlugin.configure(true)

        assert.strictEqual(iastPlugin.configured, true)
        sinon.assert.calledOnce(iastPlugin.onConfigure)
      })
    })

    describe('_execHandlerAndIncMetric', () => {
      it('should exec handler', () => {
        const handler = sinon.spy()

        iastPlugin._execHandlerAndIncMetric({
          handler
        })

        sinon.assert.calledOnce(handler)
      })

      it('should exec handler and catch exception if any', () => {
        const handler = () => { throw new Error('error') }

        // Should not throw
        iastPlugin._execHandlerAndIncMetric({
          handler
        })
        sinon.assert.calledOnce(logError)
      })

      it('should exec handler and not increase metric', () => {
        const handler = sinon.spy()
        const metric = {
          increase: sinon.spy()
        }

        iastPlugin._execHandlerAndIncMetric({
          handler,
          metric
        })

        sinon.assert.calledOnce(handler)
        sinon.assert.notCalled(metric.increase)
      })
    })
  })

  describe('with appsec telemetry enabled', () => {
    const vulnTags = [`${VULNERABILITY_TYPE}:injection`]
    const sourceTags = [`${SOURCE_TYPE}:http.source`]

    let iastTelemetry

    beforeEach(() => {
      class PluginClass {
        addSub (channelName, handler) {
          addSubMock(channelName, handler)
        }

        configure (config) {
          configureMock(config)
        }
      }
      iastTelemetry = {
        isEnabled: () => true
      }
      const IastPlugin = proxyquire('../../../src/appsec/iast/iast-plugin', {
        '../../plugins/plugin': PluginClass,
        '../../log': {
          error: logError
        },
        './telemetry': iastTelemetry,
        '../../../../datadog-instrumentations/src/helpers/instrumentations': {}
      }).IastPlugin

      iastPlugin = new IastPlugin()
    })

    afterEach(() => {
      iastPlugin.disableTelemetry()
      sinon.restore()
    })

    describe('configure', () => {
      it('should subscribe dd-trace:instrumentation:load channel', () => {
        const onInstrumentationLoadedMock = sinon.stub(iastPlugin, '_onInstrumentationLoaded')
        iastPlugin.configure(true)
        iastPlugin.configure(false)
        iastPlugin.configure(true)

        loadChannel.publish({ name: 'test' })

        sinon.assert.calledWith(onInstrumentationLoadedMock, 'test')
      })
    })

    describe('addSub', () => {
      it('should call _getTelemetryHandler with correct metrics', () => {
        const getTelemetryHandler = sinon.stub()
        iastPlugin._getTelemetryHandler = getTelemetryHandler
        iastPlugin.addSub({ channelName, tagKey: VULNERABILITY_TYPE }, handler)

        sinon.assert.calledOnceWithExactly(getTelemetryHandler, iastPlugin.pluginSubs[0])

        getTelemetryHandler.reset()

        iastPlugin.addSub({ channelName, tagKey: SOURCE_TYPE, tag: 'test-tag' }, handler)
        sinon.assert.calledOnceWithExactly(getTelemetryHandler, iastPlugin.pluginSubs[1])
      })

      it('should register a pluginSubscription and increment a sink metric when a sink module is loaded', () => {
        iastPlugin.addSub({
          moduleName: 'sink',
          channelName: 'datadog:sink:start',
          tag: 'injection',
          tagKey: VULNERABILITY_TYPE
        }, handler)
        iastPlugin.configure(true)

        const metric = getInstrumentedMetric(VULNERABILITY_TYPE)
        const metricInc = sinon.stub(metric, 'inc')

        loadChannel.publish({ name: 'sink' })

        sinon.assert.calledOnceWithExactly(metricInc, undefined, vulnTags)
      })

      it('should register and increment a sink metric when a sink module is loaded using a tracingChannel', () => {
        iastPlugin.addSub({
          channelName: 'tracing:datadog:sink:start',
          tag: 'injection',
          tagKey: VULNERABILITY_TYPE
        }, handler)
        iastPlugin.configure(true)

        const metric = getInstrumentedMetric(VULNERABILITY_TYPE)
        const metricInc = sinon.stub(metric, 'inc')

        loadChannel.publish({ name: 'sink' })

        sinon.assert.calledOnceWithExactly(metricInc, undefined, vulnTags)
      })

      it('should register an pluginSubscription and increment a source metric when a source module is loaded', () => {
        iastPlugin.addSub({
          moduleName: 'source',
          channelName: 'datadog:source:start',
          tag: 'http.source',
          tagKey: SOURCE_TYPE
        }, handler)
        iastPlugin.configure(true)

        const metric = getInstrumentedMetric(SOURCE_TYPE)
        const metricInc = sinon.stub(metric, 'inc')

        loadChannel.publish({ name: 'source' })

        sinon.assert.calledOnceWithExactly(metricInc, undefined, sourceTags)
      })

      it('should increment a sink metric when event is received', () => {
        iastPlugin.addSub({
          moduleName: 'sink',
          channelName: 'datadog:sink:start',
          tag: 'injection',
          tagKey: VULNERABILITY_TYPE
        }, handler)
        iastPlugin.configure(true)

        const metric = getExecutedMetric(VULNERABILITY_TYPE)
        const metricInc = sinon.stub(metric, 'inc')

        const telemetryHandler = addSubMock.secondCall.args[1]
        telemetryHandler()

        sinon.assert.calledOnceWithExactly(metricInc, undefined, vulnTags)
      })

      it('should increment a source metric when event is received', () => {
        iastPlugin.addSub({
          moduleName: 'source',
          channelName: 'datadog:source:start',
          tag: 'http.source',
          tagKey: SOURCE_TYPE
        }, handler)
        iastPlugin.configure(true)

        const metric = getExecutedMetric(SOURCE_TYPE)
        const metricInc = sinon.stub(metric, 'inc')

        const telemetryHandler = addSubMock.secondCall.args[1]
        telemetryHandler()

        sinon.assert.calledOnceWithExactly(metricInc, undefined, sourceTags)
      })

      it('should increment a source metric when event is received for every tag', () => {
        iastPlugin.addSub({
          moduleName: 'source',
          channelName: 'datadog:source:start',
          tag: ['http.source', 'http.source2', 'http.source3'],
          tagKey: SOURCE_TYPE
        }, handler)
        iastPlugin.configure(true)

        const metric = getExecutedMetric(SOURCE_TYPE)
        const metricInc = sinon.stub(metric, 'inc')

        const telemetryHandler = addSubMock.secondCall.args[1]
        telemetryHandler()

        sinon.assert.calledThrice(metricInc)
        sinon.assert.calledWith(metricInc.firstCall, undefined, [`${SOURCE_TYPE}:http.source`])
        sinon.assert.calledWith(metricInc.secondCall, undefined, [`${SOURCE_TYPE}:http.source2`])
        sinon.assert.calledWith(metricInc.thirdCall, undefined, [`${SOURCE_TYPE}:http.source3`])
      })
    })

    describe('_execHandlerAndIncMetric', () => {
      it('should exec handler', () => {
        const handler = sinon.spy()

        iastPlugin._execHandlerAndIncMetric({
          handler
        })

        sinon.assert.calledOnce(handler)
      })

      it('should exec handler and catch exception if any', () => {
        const handler = () => { throw new Error('error') }

        // Should not throw
        iastPlugin._execHandlerAndIncMetric({
          handler
        })
        sinon.assert.calledOnce(logError)
      })

      it('should exec handler and increase metric', () => {
        const handler = sinon.spy()
        const metric = {
          inc: sinon.spy()
        }
        const tags = 'tag1'
        const iastContext = {}
        iastPlugin._execHandlerAndIncMetric({
          handler,
          metric,
          tags,
          iastContext
        })

        sinon.assert.calledOnce(handler)
        sinon.assert.calledOnceWithExactly(metric.inc, iastContext, tags)
      })
    })
  })

  describe('Add sub to iast plugin', () => {
    class BadPlugin extends IastPlugin {
      static id = 'badPlugin'

      constructor () {
        super()
        this.addSub('appsec:badPlugin:start', this.start)
      }

      start () {
        throw new Error('this is one bad plugin')
      }
    }
    class GoodPlugin extends IastPlugin {
      static id = 'goodPlugin'

      constructor () {
        super()
        this.addSub('appsec:goodPlugin:start', this.start)
      }

      start () {}
    }

    const badPlugin = new BadPlugin()
    const goodPlugin = new GoodPlugin()

    it('should disable bad plugin', () => {
      badPlugin.configure({ enabled: true })
      assert.strictEqual(badPlugin._enabled, true)

      channel('appsec:badPlugin:start').publish({ foo: 'bar' })

      assert.strictEqual(badPlugin._enabled, false)
    })

    it('should not disable good plugin', () => {
      goodPlugin.configure({ enabled: true })
      assert.strictEqual(goodPlugin._enabled, true)

      channel('appsec:goodPlugin:start').publish({ foo: 'bar' })

      assert.strictEqual(goodPlugin._enabled, true)
    })
  })
})
