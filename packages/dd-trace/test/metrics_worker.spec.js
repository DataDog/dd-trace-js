'use strict'

wrapIt()

describe('metrics via worker thread', () => {
  let metrics
  let config
  let Client
  let workerThreads
  let worker

  beforeEach(() => {
    Client = sinon.spy()

    worker = {
      postMessage: sinon.spy()
    }

    workerThreads = {
      Worker: sinon.spy(function () {
        return worker
      }),
      isMainThread: true
    }

    metrics = proxyquire('../src/metrics', {
      './dogstatsd': Client,
      'worker_threads': workerThreads
    })

    config = {
      dogstatsd: {
        hostname: 'localhost',
        port: 8125
      },
      tags: {
        str: 'bar',
        obj: {},
        invalid: 't{e*s#t5-:./'
      }
    }

    metrics.start(config)
  })

  afterEach(() => {
    try {
      metrics.stop()
    } catch (e) {
      // already stopped
    }
  })

  describe('start', () => {
    it('it should send start to thread', () => {
      expect(worker.postMessage).to.have.been.calledWith({
        name: 'start',
        args: [config]
      })
    })
  })

  describe('stop', () => {
    it('should send stop to thread', () => {
      metrics.stop()
      expect(worker.postMessage).to.have.been.calledWith({
        name: 'stop',
        args: []
      })
    })
  })

  describe('histogram', () => {
    it('should send histogram to worker thread', () => {
      metrics.histogram('test', 1)
      expect(worker.postMessage).to.have.been.calledWith({
        name: 'histogram',
        args: ['test', 1]
      })
      metrics.histogram('test', 2)
      expect(worker.postMessage).to.have.been.calledWith({
        name: 'histogram',
        args: ['test', 2]
      })
      metrics.histogram('test', 3)
      expect(worker.postMessage).to.have.been.calledWith({
        name: 'histogram',
        args: ['test', 3]
      })
    })
  })

  describe('increment', () => {
    it('should increment a gauge', () => {
      metrics.increment('test')

      expect(worker.postMessage).to.have.been.calledWith({
        name: 'count',
        args: ['test', 1, undefined, undefined]
      })
    })

    it('should increment a gauge with a tag', () => {
      metrics.increment('test', 'foo:bar')

      expect(worker.postMessage).to.have.been.calledWith({
        name: 'count',
        args: ['test', 1, 'foo:bar', undefined]
      })
    })

    it('should increment a monotonic counter', () => {
      metrics.increment('test', true)

      expect(worker.postMessage).to.have.been.calledWith({
        name: 'count',
        args: ['test', 1, true, undefined]
      })
    })

    it('should increment a monotonic counter with a tag', () => {
      metrics.increment('test', 'foo:bar', true)

      expect(worker.postMessage).to.have.been.calledWith({
        name: 'count',
        args: ['test', 1, 'foo:bar', true]
      })
    })
  })

  describe('decrement', () => {
    it('should increment a gauge', () => {
      metrics.decrement('test')

      expect(worker.postMessage).to.have.been.calledWith({
        name: 'count',
        args: ['test', -1, undefined]
      })
    })

    it('should decrement a gauge with a tag', () => {
      metrics.decrement('test', 'foo:bar')

      expect(worker.postMessage).to.have.been.calledWith({
        name: 'count',
        args: ['test', -1, 'foo:bar']
      })
    })
  })

  describe('gauge', () => {
    it('should set a gauge', () => {
      metrics.gauge('test', 10)

      expect(worker.postMessage).to.have.been.calledWith({
        name: 'gauge',
        args: ['test', 10]
      })
    })

    it('should set a gauge with a tag', () => {
      metrics.gauge('test', 10, 'foo:bar')

      expect(worker.postMessage).to.have.been.calledWith({
        name: 'gauge',
        args: ['test', 10, 'foo:bar']
      })
    })
  })

  describe('boolean', () => {
    it('should set a gauge', () => {
      metrics.boolean('test', true)

      expect(worker.postMessage).to.have.been.calledWith({
        name: 'gauge',
        args: ['test', 1, undefined]
      })
    })

    it('should set a gauge with a tag', () => {
      metrics.boolean('test', true, 'foo:bar')

      expect(worker.postMessage).to.have.been.calledWith({
        name: 'gauge',
        args: ['test', 1, 'foo:bar']
      })
    })
  })
})
