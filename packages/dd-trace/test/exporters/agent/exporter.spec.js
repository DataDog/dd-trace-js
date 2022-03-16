'use strict'

const { expect } = require('chai')
const os = require('os')
const agent = require('../../plugins/agent')

const uuidV4Expr = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const versionExpr = /^\d+\.\d+\.\d+(-.*)?$/

const withProtocolVersions = (protocolVersions, fn) => {
  for (const protocolVersion of protocolVersions) {
    describe(`with protocol version v${protocolVersion}`, () => fn(protocolVersion))
  }
}

describe.only('Exporter', () => {
  withProtocolVersions(['0.4', '0.5'], protocolVersion => {
    let tracer

    beforeEach(() => {
      return agent.load()
    })

    beforeEach(() => {
      tracer = require('../../../../..').init({ flushInterval: 0, protocolVersion })
    })

    afterEach(() => {
      return agent.close()
    })

    it('should schedule flushing after the configured interval', done => {
      const flushInterval = 100
      const exportTime = Date.now()

      agent.use(() => {
        expect(Date.now()).to.be.gte(exportTime + flushInterval)
      }).then(done, done)

      tracer.init({ flushInterval })
      tracer.startSpan('test').finish()
    })

    it('should export a basic span', done => {
      const startTime = Date.now() * 1e6
      const testSpan = tracer.startSpan('basic')

      agent.use(traces => {
        const trace = traces[0]
        const meta = trace[0].meta
        const metrics = trace[0].metrics
        const endTime = Date.now() * 1e6

        expect(trace[0].trace_id.toString()).to.equal(testSpan.context().toTraceId())
        expect(trace[0].span_id.toString()).to.equal(testSpan.context().toSpanId())
        expect(trace[0].parent_id.toString()).to.equal('0')
        expect(trace[0].name).to.equal('basic')
        expect(trace[0].resource).to.equal('basic')
        expect(trace[0].service).to.equal('test')
        expect(trace[0].error).to.equal(0)
        expect(trace[0].start.toNumber()).to.be.gte(startTime).and.lte(endTime)
        expect(trace[0].duration.toNumber()).to.be.gte(1).and.lte(endTime - startTime)

        expect(meta['service']).to.equal('test')
        expect(meta['version']).to.match(versionExpr)
        expect(meta['runtime-id']).to.match(uuidV4Expr)
        expect(meta['span.kind']).to.equal('internal')
        expect(meta['language']).to.equal('javascript')

        expect(metrics['_sampling_priority_v1']).to.equal(1)
      }).then(done, done)

      testSpan.finish()
    })

    it('should export a trace', done => {
      const parentSpan = tracer.startSpan('parent')
      const childSpan = tracer.startSpan('child', { childOf: parentSpan.context() })

      agent.use(traces => {
        const trace = traces[0]

        expect(trace[0].trace_id.toString()).to.equal(parentSpan.context().toTraceId())
        expect(trace[0].span_id.toString()).to.equal(parentSpan.context().toSpanId())
        expect(trace[0].parent_id.toString()).to.equal('0')

        expect(trace[1].trace_id.toString()).to.equal(childSpan.context().toTraceId())
        expect(trace[1].span_id.toString()).to.equal(childSpan.context().toSpanId())
        expect(trace[1].parent_id.toString()).to.equal(parentSpan.context().toSpanId())

        expect(trace[1].duration.toNumber()).to.be.lt(trace[0].duration.toNumber())
      }).then(done, done)

      childSpan.finish()
      parentSpan.finish()
    })

    it('should support tags from the tracer', done => {
      tracer.init({
        tags: {
          tracestr: 'trace',
          tracenum: 100,
          tracebool: true
        }
      })

      const testSpan = tracer.startSpan('basic')

      agent.use(traces => {
        const trace = traces[0]
        const meta = trace[0].meta
        const metrics = trace[0].metrics

        expect(meta['tracestr']).to.equal('trace')
        expect(metrics['tracenum']).to.equal(100)
        expect(metrics['tracebool']).to.equal(1)
      }).then(done, done)

      testSpan.finish()
    })

    it('should support tags from the span', done => {
      const testSpan = tracer.startSpan('basic', {
        tags: {
          spanstr: 'span',
          spannum: 100,
          spanbool: true
        }
      })

      agent.use(traces => {
        const trace = traces[0]
        const meta = trace[0].meta
        const metrics = trace[0].metrics

        expect(meta['spanstr']).to.equal('span')
        expect(metrics['spannum']).to.equal(100)
        expect(metrics['spanbool']).to.equal(1)
      }).then(done, done)

      testSpan.finish()
    })

    it('should support tags from an error', done => {
      const testSpan = tracer.startSpan('basic')
      const error = new Error('boom')

      testSpan.setTag('error', error)

      agent.use(traces => {
        const trace = traces[0]
        const meta = trace[0].meta

        expect(trace[0].error).to.equal(1)
        expect(meta['error.type']).to.equal(error.name)
        expect(meta['error.msg']).to.equal(error.message)
        expect(meta['error.stack']).to.equal(error.stack)
      }).then(done, done)

      testSpan.finish()
    })

    it('should measure non-internal spans', done => {
      const testSpan = tracer.startSpan('basic', {
        tags: {
          'span.kind': 'server'
        }
      })

      agent.use(traces => {
        const trace = traces[0]
        const metrics = trace[0].metrics

        expect(metrics['_dd.measured']).to.equal(1)
      }).then(done, done)

      testSpan.finish()
    })

    it('should measure non-internal spans', done => {
      const testSpan = tracer.startSpan('basic', {
        tags: {
          'span.kind': 'server'
        }
      })

      agent.use(traces => {
        const trace = traces[0]
        const metrics = trace[0].metrics

        expect(metrics['_dd.measured']).to.equal(1)
      }).then(done, done)

      testSpan.finish()
    })

    it('should measure non-internal spans', done => {
      const testSpan = tracer.startSpan('basic', {
        tags: {
          'span.kind': 'server'
        }
      })

      agent.use(traces => {
        const trace = traces[0]
        const metrics = trace[0].metrics

        expect(metrics['_dd.measured']).to.equal(1)
      }).then(done, done)

      testSpan.finish()
    })

    it('should only set the language tag for the tracer service name', done => {
      const testSpan = tracer.startSpan('basic', {
        tags: {
          'service.name': 'nope'
        }
      })

      agent.use(traces => {
        const trace = traces[0]
        const meta = trace[0].meta

        expect(meta['language']).to.be.undefined
      }).then(done, done)

      testSpan.finish()
    })

    it('should set the hostname tag when configured', done => {
      tracer.init({ reportHostname: true })

      const testSpan = tracer.startSpan('basic')

      agent.use(traces => {
        const trace = traces[0]
        const meta = trace[0].meta

        expect(meta['_dd.hostname']).to.equal(os.hostname())
      }).then(done, done)

      testSpan.finish()
    })
  })
})
