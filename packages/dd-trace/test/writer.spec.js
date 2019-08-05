'use strict'

describe('Writer', () => {
  let Writer
  let writer
  let prioritySampler
  let trace
  let span
  let exporter
  let format
  let encode
  let log
  let tracer
  let scope

  beforeEach(() => {
    scope = {
      _wipe: sinon.stub()
    }

    tracer = {
      scope: sinon.stub().returns(scope)
    }

    trace = {
      started: [],
      finished: []
    }

    span = {
      tracer: sinon.stub().returns(tracer),
      context: sinon.stub().returns({
        _trace: trace,
        _sampling: {},
        _tags: {},
        _traceFlags: {}
      })
    }

    exporter = {
      send: sinon.stub()
    }

    format = sinon.stub().withArgs(span).returns('formatted')
    encode = sinon.stub().withArgs(['formatted']).returns('encoded')

    log = {
      error: sinon.spy()
    }

    prioritySampler = {
      update: sinon.stub(),
      sample: sinon.stub()
    }

    Writer = proxyquire('../src/writer', {
      './log': log,
      './format': format,
      './encode': encode,
      '../lib/version': 'tracerVersion'
    })
    writer = new Writer(prioritySampler, [exporter])
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
      trace.started = [span]
      trace.finished = []
      writer.append(span)

      expect(writer._queue).to.be.empty
    })

    it('should flush when full', () => {
      writer.append(span)
      writer._size = 8 * 1024 * 1024
      writer.append(span)

      expect(writer.length).to.equal(1)
      expect(writer._queue).to.deep.include('encoded')
    })

    it('should not append if the span was dropped', () => {
      span.context()._traceFlags.sampled = false
      writer.append(span)

      expect(writer._queue).to.be.empty
    })

    it('should generate sampling priority', () => {
      writer.append(span)

      expect(prioritySampler.sample).to.have.been.calledWith(span.context())
    })

    it('should erase the trace once finished', () => {
      trace.started = [span]
      trace.finished = [span]

      writer.append(span)

      expect(trace).to.have.deep.property('started', [])
      expect(trace).to.have.deep.property('finished', [])
      expect(span.context()).to.have.deep.property('_tags', {})
      expect(span.context()).to.have.deep.property('_metrics', {})
    })
  })

  describe('flush', () => {
    it('should skip flushing if empty', () => {
      writer.flush()

      expect(exporter.send).to.not.have.been.called
    })

    it('should empty the internal queue', () => {
      writer.append(span)
      writer.flush()

      expect(exporter.send).to.have.been.called
      expect(writer.length).to.equal(0)
    })
  })
})
