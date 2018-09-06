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
  let log

  beforeEach(() => {
    trace = {
      started: [span],
      finished: [span]
    }

    span = {
      context: sinon.stub().returns({ trace })
    }

    platform = {
      name: sinon.stub(),
      version: sinon.stub(),
      engine: sinon.stub(),
      request: sinon.stub().returns(Promise.resolve()),
      msgpack: {
        prefix: sinon.stub()
      }
    }

    format = sinon.stub().withArgs(span).returns('formatted')
    encode = sinon.stub().withArgs(['processed']).returns('encoded')

    url = {
      protocol: 'http:',
      hostname: 'localhost',
      port: 8126
    }

    log = {
      error: sinon.spy()
    }

    Writer = proxyquire('../src/writer', {
      './platform': platform,
      './log': log,
      './format': format,
      './encode': encode,
      '../lib/version': 'tracerVersion'
    })
  })

  describe('length', () => {
    beforeEach(() => { writer = new Writer(url, 3, []) })

    it('should return the number of traces', () => {
      writer.append(span)
      writer.append(span)

      expect(writer.length).to.equal(2)
    })
  })

  describe('applyProcessors', () => {
    describe('with no processors configured', () => {
      it('returns the trace', () => {
        writer = new Writer(url, 3, [])
        const formattedTrace = trace.finished.map(format)
        expect(writer.applyProcessors(formattedTrace)).to.eq(formattedTrace)
      })
    })

    describe('with processors configured', () => {
      it('passes the trace through the processors and then returns it', () => {
        const processors = [
          sinon.stub().withArgs(['formatted']).returns(['partly-processed']),
          sinon.stub().withArgs(['partly-processed']).returns(['processed'])
        ]

        writer = new Writer(url, 3, processors)
        const formattedTrace = trace.finished.map(format)
        expect(writer.applyProcessors(formattedTrace)).to.deep.eq(['processed'])
      })

      describe('when a processor skips the trace', () => {
        it('returns undefined, and does not call the other processors', () => {
          const neverCalledProcessor = sinon.spy()

          const processors = [
            sinon.stub().withArgs('formatted').returns(undefined),
            neverCalledProcessor
          ]

          writer = new Writer(url, 3, processors)
          const formattedTrace = trace.finished.map(format)
          expect(writer.applyProcessors(formattedTrace)).to.be.undefined
          expect(neverCalledProcessor).to.not.have.been.called
        })
      })
    })
  })

  describe('append', () => {
    it('should append a trace', () => {
      writer = new Writer(url, 3, [])
      writer.append(span)

      expect(writer._queue).to.deep.include('encoded')
    })

    it('should run traces through any processors', () => {
      const firstAlteringProcessor = sinon.stub().withArgs(['formatted']).returns(['partly-processed'])
      const secondAlteringProcessor = sinon.stub().withArgs(['partly-processed']).returns(['processed'])
      const processors = [firstAlteringProcessor, secondAlteringProcessor]
      writer = new Writer(url, 3, processors)

      writer.append(span)

      expect(encode).to.have.been.called
      expect(writer._queue).to.deep.include('encoded')
    })

    describe('when a processor skips the trace', () => {
      it('does not add the trace to the queue', () => {
        const processors = [
          sinon.stub().withArgs(['formatted']).returns(undefined)
        ]

        writer = new Writer(url, 3, processors)
        writer.append(span)
        expect(writer._queue).to.be.empty
      })
    })

    it('should skip traces with unfinished spans', () => {
      writer = new Writer(url, 3, [])
      trace.finished = []
      writer.append(span)

      expect(writer._queue).to.be.empty
    })

    it('should replace a random trace when full', () => {
      writer = new Writer(url, 3, [])
      writer._queue = new Array(1000)
      writer.append(span)

      expect(writer.length).to.equal(1000)
      expect(writer._queue).to.deep.include('encoded')
    })
  })

  describe('flush', () => {
    beforeEach(() => { writer = new Writer(url, 3, []) })

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
      platform.name.returns('lang')
      platform.version.returns('version')
      platform.engine.returns('interpreter')

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
          'Content-Type': 'application/msgpack',
          'Datadog-Meta-Lang': 'lang',
          'Datadog-Meta-Lang-Version': 'version',
          'Datadog-Meta-Lang-Interpreter': 'interpreter',
          'Datadog-Meta-Tracer-Version': 'tracerVersion',
          'X-Datadog-Trace-Count': '2'
        },
        data: 'prefixed'
      })
    })

    it('should log request errors', done => {
      const error = new Error('boom')

      platform.request.returns(Promise.reject(error))

      writer.append(span)
      writer.flush()

      setTimeout(() => {
        expect(log.error).to.have.been.calledWith(error)
        done()
      })
    })
  })
})
