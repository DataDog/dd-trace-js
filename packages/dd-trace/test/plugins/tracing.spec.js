const TracingPlugin = require('../../src/plugins/tracing')
const Config = require('../../src/config')
const DatadogTracer = require('../../src/opentracing/tracer')

describe('TracingPlugin', () => {
  describe('startSpan method', () => {
    it('passes given childOf relationship to the tracer', () => {
      const startSpanSpy = sinon.spy()
      const plugin = new TracingPlugin({
        _tracer: {
          startSpan: startSpanSpy
        }
      })
      plugin.configure({})

      plugin.startSpan('Test span', { childOf: 'some parent span' })

      expect(startSpanSpy).to.have.been.calledWith(
        'Test span',
        sinon.match({
          childOf: 'some parent span'
        })
      )
    })
  })
})
