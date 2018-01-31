'use strict'

const Uint64BE = require('int64-buffer').Uint64BE
const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })

describe('Writer', () => {
  let Writer
  let writer
  let platform
  let url

  beforeEach(() => {
    platform = {
      request: sinon.spy()
    }
    url = {
      protocol: 'http:',
      hostname: 'localhost',
      port: 8126
    }
    Writer = proxyquire('../src/writer', {
      './platform': platform
    })
    writer = new Writer(url, 3)
  })

  describe('length', () => {
    it('should return the number of traces', () => {
      writer.append({})
      writer.append({})

      expect(writer.length).to.equal(2)
    })
  })

  describe('flush', () => {
    it('should skip flushing if empty', () => {
      writer.flush()

      expect(platform.request).to.not.have.been.called
    })

    it('should empty the internal queue', () => {
      writer.append({})
      writer.flush()

      expect(writer.length).to.equal(0)
    })

    it('should flush its content to the agent', () => {
      const uint64 = new Uint64BE(0x12345678, 0x90abcdef)
      const expected = uint64.toString()

      writer.append({ foo: 'foo' })
      writer.append({ bar: uint64 })
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
      expect(payload[0].foo).to.equal('foo')
      expect(payload[1].bar.toString()).to.equal(expected)
    })

    it('should flush automatically when full', () => {
      writer.append({})
      writer.append({})
      writer.append({})

      expect(writer.length).to.equal(0)
      expect(platform.request).to.have.been.called
    })
  })
})
