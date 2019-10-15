'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

wrapIt()

describe('Plugin', () => {
  let tracer
  let span
  let spy

  async function setup (logInjection) {
    tracer = require('../../dd-trace/')
    await agent.load(plugin, 'console', {}, { logInjection })
    span = tracer.startSpan('test')
    spy = sinon.spy(process.stdout, 'write')
  }

  function teardown () {
    spy.restore()
    return agent.close()
  }

  describe('console', () => {
    describe('without configuration', () => {
      beforeEach(() => {
        return setup(false)
      })
      afterEach(() => {
        return teardown()
      })

      it('should not alter the default behavior', () => {
        tracer.scope().activate(span, () => {
          // eslint-disable-next-line no-console
          console.log('message')
          expect(process.stdout.write.firstCall.args[0]).to.equal('message\n')
        })
      })
    })

    describe('with configuration', () => {
      beforeEach(() => {
        return setup(true)
      })
      afterEach(() => {
        return teardown()
      })
      it('should add the trace identifiers to logger instances', () => {
        tracer.scope().activate(span, () => {
          // eslint-disable-next-line no-console
          console.log('message')

          const record = process.stdout.write.firstCall.args[0]
          const traceId = span.context().toTraceId()
          const spanId = span.context().toSpanId()
          expect(record).to.equal(`[dd.trace_id=${traceId} dd.span_id=${spanId}] message\n`)
        })
      })
      it('should add the trace identifiers to multiargument logs', () => {
        tracer.scope().activate(span, () => {
          // eslint-disable-next-line no-console
          console.log('message', JSON.stringify({ hello: 'world' }))

          const record = process.stdout.write.firstCall.args[0]
          const traceId = span.context().toTraceId()
          const spanId = span.context().toSpanId()
          expect(record).to.equal(`[dd.trace_id=${traceId} dd.span_id=${spanId}] message {"hello":"world"}\n`)
        })
      })
      it('should add the trace identifiers to no argument logs', () => {
        tracer.scope().activate(span, () => {
          // eslint-disable-next-line no-console
          console.log()

          const record = process.stdout.write.firstCall.args[0]
          const traceId = span.context().toTraceId()
          const spanId = span.context().toSpanId()
          expect(record).to.equal(`[dd.trace_id=${traceId} dd.span_id=${spanId}]\n`)
        })
      })
    })
  })
})
