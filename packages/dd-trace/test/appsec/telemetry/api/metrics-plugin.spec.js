'use strict'

const { expect } = require('chai')
const proxyquire = require('proxyquire')

describe('MetricsTelemetryPlugin', () => {
  const m1 = { name: 'm1' }
  const m2 = { name: 'm2' }
  const m3 = { name: 'm3' }
  const d1 = { name: 'd1', type: 'distribution' }

  let sendDataMock, TelemetryPlugin, metrics

  beforeEach(() => {
    sendDataMock = sinon.stub()
    TelemetryPlugin = proxyquire('../../../../src/appsec/telemetry/api/plugin', {
      '../../../telemetry/send-data': {
        sendData: sendDataMock
      }
    })

    metrics = proxyquire('../../../../src/appsec/telemetry/api/metrics-plugin', {
      './plugin': TelemetryPlugin
    })
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('getPayload', () => {
    it('should obtain metrics from every registered providers', () => {
      const iast = sinon.stub().returns([m1, m2])
      const other = sinon.stub().returns([m3])

      metrics.registerProvider(iast)
      metrics.registerProvider(other)

      const payload = metrics.getPayload()

      expect(iast).to.have.been.calledOnce
      expect(other).to.have.been.calledOnce
      expect(payload['generate-metrics']).to.contain(m1, m2, m3)
    })

    it('should split metrics and distributions from every registered providers', () => {
      const iast = sinon.stub().returns([m1, m2])
      const other = sinon.stub().returns([d1])

      metrics.registerProvider(iast)
      metrics.registerProvider(other)

      const payload = metrics.getPayload()

      expect(payload['generate-metrics']).to.contain(m1, m2, m3)
      expect(payload['distributions']).to.contain(d1)
    })
  })

  describe('onSendData', () => {
    it('should obtain the payload and send it with sendData and \'generate-metrics\' request type', () => {
      const config = {}
      const application = {}
      const host = 'host'

      metrics.start(config, application, host)

      const iast = sinon.stub().returns([m1, m2])
      metrics.registerProvider(iast)

      metrics.onSendData()

      expect(sendDataMock).to.have.been.calledOnceWith(config, application, host, 'generate-metrics', {
        namespace: 'tracers',
        series: [m1, m2]
      })
    })

    it('should send metrics and distributions', () => {
      const config = {}
      const application = {}
      const host = 'host'

      metrics.start(config, application, host)

      const iast = sinon.stub().returns([m1, m2, d1])
      metrics.registerProvider(iast)

      metrics.onSendData()

      expect(sendDataMock).to.have.been.calledTwice

      expect(sendDataMock.firstCall.args).to.be.deep.eq([config, application, host, 'generate-metrics', {
        namespace: 'tracers',
        series: [m1, m2]
      }])

      expect(sendDataMock.secondCall.args).to.be.deep.eq([config, application, host, 'distributions', {
        namespace: 'tracers',
        series: [d1]
      }])
    })
  })

  describe('providers', () => {
    it('should register only one provider if register is called several times with same provider', () => {
      const iast = sinon.stub().returns([m1, m2])
      metrics.registerProvider(iast)
      metrics.registerProvider(iast)
      metrics.registerProvider(iast)

      expect(metrics.providers.size).to.be.eq(1)
    })

    it('should stop interval if there are no more providers registered', () => {
      const iast = sinon.stub().returns([m1, m2])
      const other = sinon.stub().returns([m3])
      const stopInterval = sinon.stub(metrics, 'stopInterval')

      metrics.registerProvider(iast)
      metrics.registerProvider(other)

      metrics.unregisterProvider(iast)
      expect(stopInterval).to.not.be.called

      metrics.unregisterProvider(other)
      expect(stopInterval).to.be.calledOnce
    })
  })
})
