'use strict'

const express = require('express')
const bodyParser = require('body-parser')
const getPort = require('get-port')
const Uint64BE = require('int64-buffer').Uint64BE
const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })

const { SAMPLING_PRIORITY_KEY } = require('../src/constants')

describe('dd-trace', () => {
  let tracer
  let agent
  let listener

  beforeEach(() => {
    tracer = require('../')

    return getPort().then(port => {
      agent = express()
      listener = agent.listen(port)

      tracer.init({
        service: 'test',
        port,
        flushInterval: 0,
        plugins: false
      })
    })
  })

  afterEach(() => {
    listener.close()
    delete require.cache[require.resolve('../')]
    delete global._ddtrace
  })

  it('should record and send a trace to the agent', (done) => {
    const span = tracer.startSpan('hello', {
      tags: {
        'resource.name': '/hello/:name'
      }
    })

    agent.use(bodyParser.raw({ type: 'application/msgpack' }))
    agent.put('/v0.4/traces', (req, res) => {
      if (req.body.length === 0) return res.status(200).send()

      try {
        const payload = msgpack.decode(req.body, { codec })

        expect(payload[0][0].trace_id.toString()).to.equal(span.context()._traceId.toString(10))
        expect(payload[0][0].span_id.toString()).to.equal(span.context()._spanId.toString(10))
        expect(payload[0][0].service).to.equal('test')
        expect(payload[0][0].name).to.equal('hello')
        expect(payload[0][0].resource).to.equal('/hello/:name')
        expect(payload[0][0].start).to.be.instanceof(Uint64BE)
        expect(payload[0][0].duration).to.be.instanceof(Uint64BE)
        expect(payload[0][0].metrics).to.have.property(SAMPLING_PRIORITY_KEY)

        res.status(200).send('OK')

        done()
      } catch (e) {
        done(e)
      }
    })

    span.finish()
  })
})
