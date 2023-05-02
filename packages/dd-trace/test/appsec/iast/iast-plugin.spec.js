'use strict'

const { expect } = require('chai')
const { channel } = require('../../../../diagnostics_channel')
const proxyquire = require('proxyquire')
const { getExecutedMetric, getInstrumentedMetric, MetricTag } = require('../../../src/appsec/iast/iast-metric')

const VULNERABILITY_TYPE = MetricTag.VULNERABILITY_TYPE
const SOURCE_TYPE = MetricTag.SOURCE_TYPE

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

  describe('with telemetry disabled', () => {
    let IastPlugin

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
        '../../log': {
          error: logError
        },
        './iast-context': {
          getIastContext: getIastContext
        },
        '../telemetry': {
          isEnabled: () => false
        },
        './telemetry/metrics': {},
        '../../../../datadog-core': datadogCore
      })
      IastPlugin = iastPluginMod.IastPlugin
      iastPlugin = new IastPlugin()
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
        iastPlugin.addSub({ channelName, metricTag: VULNERABILITY_TYPE }, handler)

        expect(wrapHandler).to.be.calledOnceWith(handler)
        expect(getTelemetryHandler).to.be.not.called

        wrapHandler.reset()
        getTelemetryHandler.reset()

        iastPlugin.addSub({ channelName, metricTag: SOURCE_TYPE, tag: 'test-tag' }, handler)
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
  })

  describe('with telemetry enabled', () => {
    let telemetry
    let IastPlugin

    beforeEach(() => {
      class PluginClass {
        addSub (channelName, handler) {
          addSubMock(channelName, handler)
        }
        configure (config) {
          configureMock(config)
        }
      }
      telemetry = {
        isEnabled: () => true,
        isDebugEnabled: () => true
      }
      IastPlugin = proxyquire('../../../src/appsec/iast/iast-plugin', {
        '../../plugins/plugin': PluginClass,
        '../../log': {
          error: logError
        },
        '../telemetry': telemetry
      }).IastPlugin

      iastPlugin = new IastPlugin()
    })

    afterEach(() => {
      iastPlugin.disableTelemetry()
      sinon.restore()
    })

    describe('configure', () => {
      it('should subscribe dd-trace:instrumentation:load channel', () => {
        const onInstrumentationLoadedMock = sinon.stub(iastPlugin, 'onInstrumentationLoaded')
        iastPlugin.configure(true)
        iastPlugin.configure(false)
        iastPlugin.configure(true)

        loadChannel.publish({ name: 'test' })

        expect(onInstrumentationLoadedMock).to.be.calledOnceWith('test')
      })
    })

    describe('addSub', () => {
      it('should call _getTelemetryHandler with correct metrics', () => {
        const wrapHandler = sinon.stub()
        iastPlugin._wrapHandler = wrapHandler
        const getTelemetryHandler = sinon.stub()
        iastPlugin._getTelemetryHandler = getTelemetryHandler
        iastPlugin.addSub({ channelName, metricTag: VULNERABILITY_TYPE }, handler)

        expect(wrapHandler).to.be.calledOnceWith(handler)
        expect(getTelemetryHandler).to.be.calledOnceWith(getExecutedMetric(VULNERABILITY_TYPE), undefined)

        wrapHandler.reset()
        getTelemetryHandler.reset()

        iastPlugin.addSub({ channelName, metricTag: SOURCE_TYPE, tag: 'test-tag' }, handler)
        expect(wrapHandler).to.be.calledOnceWith(handler)
        expect(getTelemetryHandler).to.be.calledOnceWith(getExecutedMetric(SOURCE_TYPE), 'test-tag')
      })

      it('should register an pluginSubscription and increment a sink metric when a sink module is loaded', () => {
        iastPlugin.addSub({
          moduleName: 'sink',
          channelName: 'datadog:sink:start',
          tag: 'injection',
          metricTag: VULNERABILITY_TYPE
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
          metricTag: SOURCE_TYPE
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
          metricTag: VULNERABILITY_TYPE
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
          metricTag: SOURCE_TYPE
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
          metricTag: SOURCE_TYPE
        }, handler)
        iastPlugin.configure(true)

        const metric = getExecutedMetric(SOURCE_TYPE)
        const metricAdd = sinon.stub(metric, 'add')

        const telemetryHandler = addSubMock.secondCall.args[1]
        telemetryHandler()

        expect(metricAdd).to.be.calledOnceWith(1, [ 'http.source', 'http.source2', 'http.source3' ])
      })
    })
  })
})
