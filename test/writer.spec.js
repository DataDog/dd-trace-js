'use strict'

describe('Writer', () => {
  let Writer
  let writer
  let trace
  let span
  let platform
  let format
  let encode
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
      request: sinon.spy(),
      msgpack: {
        prefix: sinon.stub()
      }
    }

    format = sinon.stub().withArgs(span).returns('formatted')
    encode = sinon.stub().withArgs(['formatted']).returns('encoded')

    url = {
      protocol: 'http:',
      hostname: 'localhost',
      port: 8126
    }

    Writer = proxyquire('../src/writer', {
      './platform': platform,
      './format': format,
      './encode': encode
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

  describe('append', () => {
    it('should append a trace', () => {
      writer.append(span)

      expect(writer._queue).to.deep.include('encoded')
    })

    it('should skip traces with unfinished spans', () => {
      trace.finished = []
      writer.append(span)

      expect(writer._queue).to.be.empty
    })

    it('should replace a random trace when full', () => {
      writer._queue = new Array(1000)
      writer.append(span)

      expect(writer.length).to.equal(1000)
      expect(writer._queue).to.deep.include('encoded')
    })
  })

  describe('flush', () => {
    it('should skip flushing if empty', () => {
      writer.flush()

      expect(platform.request).to.not.have.been.called
    })

    it('should empty the internal queue', () => {
      writer.append(span)
      writer.flush()

      expect(writer.length).to.equal(0)
    })

    it('should flush its traces to the agent', () => {
      platform.msgpack.prefix.withArgs(['encoded', 'encoded']).returns('prefixed')

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
        },
        data: 'prefixed'
      })
    })
  })
})
