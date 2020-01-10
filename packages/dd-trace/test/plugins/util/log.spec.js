'use strict'

wrapIt()

describe('plugins/util/log', () => {
  let log
  let tracer

  beforeEach(() => {
    tracer = require('../../..').init({ service: 'test', plugins: false })
    log = require('../../../src/plugins/util/log')
  })

  describe('correlate', () => {
    it('should attach the current scope trace identifiers to the log record', () => {
      const span = tracer.startSpan('test')

      tracer.scope().activate(span, () => {
        const record = log.correlate(tracer, {})

        expect(record).to.have.deep.property('dd', {
          trace_id: span.context().toTraceId(),
          span_id: span.context().toSpanId()
        })
      })
    })

    it('should return a new correlated log record if one was not provided', () => {
      const span = tracer.startSpan('test')

      tracer.scope().activate(span, () => {
        const record = log.correlate(tracer)

        expect(record).to.have.deep.property('dd', {
          trace_id: span.context().toTraceId(),
          span_id: span.context().toSpanId()
        })
      })
    })

    it('should do nothing if there is no active scope', () => {
      const record = log.correlate(tracer, {})

      expect(record).to.not.have.property('dd')
    })

    it('should do nothing if the active span is null', () => {
      tracer.scope().activate(null, () => {
        const record = log.correlate(tracer)

        expect(record).to.be.undefined
      })
    })

    it('should not alter the original object', () => {
      const span = tracer.startSpan('test')

      tracer.scope().activate(span, () => {
        const record = {}

        log.correlate(tracer, record)

        expect(record).to.not.have.property('dd')
      })
    })

    it('should preserve existing properties', () => {
      const span = tracer.startSpan('test')

      tracer.scope().activate(span, () => {
        const record = Object.create({ parent: 'parent' })

        record.own = 'own'

        const carrier = log.correlate(tracer, record)

        expect(carrier).to.have.property('own', 'own')
        expect(carrier).to.have.property('parent', 'parent')
      })
    })

    it('should preserve existing Symbol properties', () => {
      const span = tracer.startSpan('test')

      tracer.scope().activate(span, () => {
        const record = Object.create({ parent: 'parent' })
        const splat = 'splat'
        const splatSymbol = Symbol.for(splat)

        record.own = 'own'
        record[splatSymbol] = splat

        const carrier = log.correlate(tracer, record)

        expect(carrier).to.have.property('own', 'own')
        expect(carrier).to.have.property('parent', 'parent')
        expect(carrier).to.have.property(splatSymbol, splat)
      })
    })
  })
})
