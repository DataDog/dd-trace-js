'use strict'

const { expect } = require('chai')
const agent = require('../../plugins/agent')

describe('Exporter', () => {
  let tracer

  beforeEach(() => {
    return agent.load()
  })

  beforeEach(() => {
    tracer = require('../../../../..').init({ flushInterval: 0 })
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

  it('should export a span', done => {
    agent.use(traces => {
      const span = traces[0][0]

      expect(span).to.have.property('trace_id')
    }).then(done, done)

    tracer.startSpan('test').finish()
  })

  describe('setUrl', () => {
    it('should set the URL on self and writer', done => {
      const { address, port } = agent.server.address()

      tracer.init({ hostname: 'localhost', port: '8124' })
      tracer.setUrl(`http://${address}:${port}`)

      agent.use(() => {}).then(done)

      tracer.startSpan('test').finish()
    })
  })
})
