'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

wrapIt()

describe('Plugin', () => {
  let localConsole
  let tracer
  let span

  function setup (version) {
    span = tracer.startSpan('test')

    localConsole = { ...console }
    sinon.spy(localConsole, 'log')
  }

  describe('console', () => {
    beforeEach(() => {
      tracer = require('../../dd-trace')
      return agent.load(plugin, 'console')
    })

    afterEach(() => {
      return agent.close()
    })

    withVersions(plugin, 'console', version => {
      describe('without configuration', () => {
        beforeEach(() => {
          setup(version)
        })

        it('should not alter the default behavior', () => {
          tracer.scope().activate(span, () => {
            localConsole.log('message')
            expect(localConsole.log.firstCall.args[0]).toEqual('message')
          })
        })
      })

      describe('with configuration', () => {
        beforeEach(() => {
          tracer._tracer._logInjection = true
          setup(version)
        })
        it('should add the trace identifiers to logger instances', () => {
          tracer.scope().activate(span, () => {
            localConsole.log('message')

            expect(localConsole.log).to.have.been.called

            const record = localConsole.load.firstCall.args[0].toString()
            const traceId = span.context().toTraceId()
            const spanId = span.context().toSpanId()
            expect(record).toEqual(`[trace_id:${traceId}, span_id:${spanId}] message`)
          })
        })
      })
    })
  })
})
