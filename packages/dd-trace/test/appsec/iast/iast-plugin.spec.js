'use strict'

const { expect } = require('chai')
const { channel } = require('dc-polyfill')
const proxyquire = require('proxyquire')
const { getExecutedMetric, getInstrumentedMetric, TagKey } = require('../../../src/appsec/iast/telemetry/iast-metric')

const VULNERABILITY_TYPE = TagKey.VULNERABILITY_TYPE
const SOURCE_TYPE = TagKey.SOURCE_TYPE

describe('IAST Plugin', () => {
  const loadChannel = channel('dd-trace:instrumentation:load')

  let logError, addSubMock, getIastContext, configureMock, datadogCore

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

      datadogCore = {
        storage: {
          getStore: sinon.stub()
        }
      }

      const iastPluginMod = proxyquire('../../../src/appsec/iast/iast-plugin', {
        '../../plugins/plugin': PluginClass,
        './iast-log': {
          errorAndPublish: logError
        },
        './iast-context': {
          getIastContext: getIastContext
        },
        './telemetry': {
          isEnabled: () => false
        },
        './telemetry/metrics': {},
        '../../../../datadog-core': datadogCore
      })
      iastPlugin = new iastPluginMod.IastPlugin()
    })

    afterEach(() => {
      iastPlugin.disableTelemetry()
    })

    describe('addSub', () => {
      it('should call Plugin.addSub with channelName and wrapped handler', () => {
        iastPlugin.addSub('test', handler)

        expect(addSubMock).to.be.calledOnce
        const args = addSubMock.getCall(0).args
        expect(args[0]).equal('test')

        const wrapped = args[1]
        expect(wrapped).to.be.a('function')
        expect(wrapped).to.not.be.equal(handler)
        expect(wrapped()).to.not.throw
        expect(logError).to.be.calledOnce
      })

      it('should call Plugin.addSub with channelName and wrapped handler after registering iastPluginSub', () => {
        const iastPluginSub = { channelName: 'test' }
        iastPlugin.addSub(iastPluginSub, handler)

        expect(addSubMock).to.be.calledOnce
        const args = addSubMock.getCall(0).args
        expect(args[0]).equal('test')

        const wrapped = args[1]
        expect(wrapped).to.be.a('function')
        expect(wrapped).to.not.be.equal(handler)
        expect(wrapped()).to.not.throw
        expect(logError).to.be.calledOnce
      })

      it('should infer moduleName from channelName after registering iastPluginSub', () => {
        const iastPluginSub = { channelName: 'test' }
        iastPlugin.addSub(iastPluginSub, handler)

        expect(iastPlugin.pluginSubs).to.have.lengthOf(1)
        expect(iastPlugin.pluginSubs[0].moduleName).eq('test')
      })

      it('should infer moduleName from channelName after registering iastPluginSub with real channelName', () => {
        const iastPluginSub = { channelName: 'datadog:test:start' }
        iastPlugin.addSub(iastPluginSub, handler)

        expect(iastPlugin.pluginSubs).to.have.lengthOf(1)
        expect(iastPlugin.pluginSubs[0].moduleName).eq('test')
      })

      it('should not call _getTelemetryHandler', () => {
        const wrapHandler = sinon.stub()
        iastPlugin._wrapHandler = wrapHandler
        const getTelemetryHandler = sinon.stub()
        iastPlugin._getTelemetryHandler = getTelemetryHandler
        iastPlugin.addSub({ channelName, tagKey: VULNERABILITY_TYPE }, handler)

        expect(wrapHandler).to.be.calledOnceWith(handler)
        expect(getTelemetryHandler).to.be.not.called

        wrapHandler.reset()
        getTelemetryHandler.reset()

        iastPlugin.addSub({ channelName, tagKey: SOURCE_TYPE, tag: 'test-tag' }, handler)
        expect(wrapHandler).to.be.calledOnceWith(handler)
        expect(getTelemetryHandler).to.be.not.called
      })
    })

    describe('configure', () => {
      it('should mark Plugin configured and call only once onConfigure', () => {
        iastPlugin.onConfigure = sinon.stub()
        iastPlugin.configure(true)
        iastPlugin.configure(false)
        iastPlugin.configure(true)

        expect(iastPlugin.configured).to.be.true
        expect(iastPlugin.onConfigure).to.be.calledOnce
      })
    })

    describe('_execHandlerAndIncMetric', () => {
      it('should exec handler', () => {
        const handler = sinon.spy()

        iastPlugin._execHandlerAndIncMetric({
          handler
        })

        expect(handler).to.be.calledOnce
      })

      it('should exec handler and catch exception if any', () => {
        const handler = () => { throw new Error('error') }

        expect(iastPlugin._execHandlerAndIncMetric({
          handler
        })).to.not.throw
        expect(logError).to.be.calledOnce
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

        expect(handler).to.be.calledOnce
        expect(metric.increase).to.not.be.called
      })
    })
  })

  describe('with appsec telemetry enabled', () => {
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
        './iast-log': {
          errorAndPublish: logError
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

        expect(onInstrumentationLoadedMock).to.be.calledWith('test')
      })
    })

    describe('addSub', () => {
      it('should call _getTelemetryHandler with correct metrics', () => {
        const wrapHandler = sinon.stub()
        iastPlugin._wrapHandler = wrapHandler
        const getTelemetryHandler = sinon.stub()
        iastPlugin._getTelemetryHandler = getTelemetryHandler
        iastPlugin.addSub({ channelName, tagKey: VULNERABILITY_TYPE }, handler)

        expect(wrapHandler).to.be.calledOnceWith(handler)
        expect(getTelemetryHandler).to.be.calledOnceWith(iastPlugin.pluginSubs[0])

        wrapHandler.reset()
        getTelemetryHandler.reset()

        iastPlugin.addSub({ channelName, tagKey: SOURCE_TYPE, tag: 'test-tag' }, handler)
        expect(wrapHandler).to.be.calledOnceWith(handler)
        expect(getTelemetryHandler).to.be.calledOnceWith(iastPlugin.pluginSubs[1])
      })

      it('should register an pluginSubscription and increment a sink metric when a sink module is loaded', () => {
        iastPlugin.addSub({
          moduleName: 'sink',
          channelName: 'datadog:sink:start',
          tag: 'injection',
          tagKey: VULNERABILITY_TYPE
        }, handler)
        iastPlugin.configure(true)

        const metric = getInstrumentedMetric(VULNERABILITY_TYPE)
        const metricAdd = sinon.stub(metric, 'add')

        loadChannel.publish({ name: 'sink' })

        expect(metricAdd).to.be.calledOnceWith(1, 'injection')
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
        const metricAdd = sinon.stub(metric, 'add')

        loadChannel.publish({ name: 'source' })

        expect(metricAdd).to.be.calledOnceWith(1, 'http.source')
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
        const metricAdd = sinon.stub(metric, 'add')

        const telemetryHandler = addSubMock.secondCall.args[1]
        telemetryHandler()

        expect(metricAdd).to.be.calledOnceWith(1, 'injection')
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
        const metricAdd = sinon.stub(metric, 'add')

        const telemetryHandler = addSubMock.secondCall.args[1]
        telemetryHandler()

        expect(metricAdd).to.be.calledOnceWith(1, 'http.source')
      })

      it('should increment a source metric when event is received for every tag', () => {
        iastPlugin.addSub({
          moduleName: 'source',
          channelName: 'datadog:source:start',
          tag: [ 'http.source', 'http.source2', 'http.source3' ],
          tagKey: SOURCE_TYPE
        }, handler)
        iastPlugin.configure(true)

        const metric = getExecutedMetric(SOURCE_TYPE)
        const metricAdd = sinon.stub(metric, 'add')

        const telemetryHandler = addSubMock.secondCall.args[1]
        telemetryHandler()

        expect(metricAdd).to.be.calledOnceWith(1, [ 'http.source', 'http.source2', 'http.source3' ])
      })
    })

    describe('_execHandlerAndIncMetric', () => {
      it('should exec handler', () => {
        const handler = sinon.spy()

        iastPlugin._execHandlerAndIncMetric({
          handler
        })

        expect(handler).to.be.calledOnce
      })

      it('should exec handler and catch exception if any', () => {
        const handler = () => { throw new Error('error') }

        expect(iastPlugin._execHandlerAndIncMetric({
          handler
        })).to.not.throw
        expect(logError).to.be.calledOnce
      })

      it('should exec handler and increase metric', () => {
        const handler = sinon.spy()
        const metric = {
          inc: sinon.spy()
        }
        const tag = 'tag1'
        const iastContext = {}
        iastPlugin._execHandlerAndIncMetric({
          handler,
          metric,
          tag,
          iastContext
        })

        expect(handler).to.be.calledOnce
        expect(metric.inc).to.be.calledOnceWithExactly(tag, iastContext)
      })
    })
  })
})
