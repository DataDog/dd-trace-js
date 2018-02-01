'use strict'

const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })

describe('Writer', () => {
  let Writer
  let writer
  let trace
  let span
  let platform
  let format
  let url

  beforeEach(() => {
    trace = {
      started: [span],
      finished: [span]
    }

    span = {
      context: sinon.stub().returns({ trace })
    }

    platform = {
      request: sinon.spy()
    }

    format = sinon.stub().withArgs(span).returns('span')

    url = {
      protocol: 'http:',
      hostname: 'localhost',
      port: 8126
    }

    Writer = proxyquire('../src/writer', {
      './platform': platform,
      './format': format
    })
    writer = new Writer(url, 3)
  })

  describe('length', () => {
    it('should return the number of traces', () => {
      writer.append(span)
      writer.append(span)

      expect(writer.length).to.equal(2)
    })
  })

  describe('flush', () => {
    it('should skip flushing if empty', () => {
      writer.flush()

      expect(platform.request).to.not.have.been.called
    })

    it('should skip flushing if all spans of the trace are not finished', () => {
      trace.finished = []
      writer.append(span)
      writer.flush()

      expect(platform.request).to.not.have.been.called
    })

    it('should empty the internal queue', () => {
      writer.append(span)
      writer.flush()

      expect(writer.length).to.equal(0)
    })

    it('should flush its traces to the agent', () => {
      writer.append(span)
      writer.append(span)
      writer.flush()

      expect(platform.request).to.have.been.calledWithMatch({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: '/v0.3/traces',
        method: 'PUT',
        headers: {
          'Content-Type': 'application/msgpack'
        }
      })

      const data = platform.request.firstCall.args[0].data
      const payload = msgpack.decode(Buffer.concat(data), { codec })

      expect(payload).to.be.instanceof(Array)
      expect(payload.length).to.equal(2)
    })

    it('should flush traces with the correct format', () => {
      writer.append(span)
      writer.flush()

      const data = platform.request.firstCall.args[0].data
      const payload = msgpack.decode(Buffer.concat(data), { codec })

      expect(payload[0][0]).to.equal('span')
    })

    it('should flush automatically when full', () => {
      writer.append(span)
      writer.append(span)
      writer.append(span)

      expect(writer.length).to.equal(0)
      expect(platform.request).to.have.been.called
    })
  })
})
