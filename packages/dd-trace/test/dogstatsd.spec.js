'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const os = require('node:os')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('./setup/core')

describe('dogstatsd', () => {
  let client
  let DogStatsDClient
  let CustomMetrics
  let MetricsAggregationClient
  let dgram
  let udp4
  let udp6
  let dns
  let httpServer
  let httpPort
  let httpData
  let httpUdsServer
  let udsPath
  let statusCode
  let sockets
  let assertData
  let docker
  let log

  beforeEach((done) => {
    udp6 = {
      send: sinon.spy(),
      on: sinon.stub().returns(udp6),
      unref: sinon.stub().returns(udp6),
    }

    udp4 = {
      send: sinon.spy(),
      on: sinon.stub().returns(udp4),
      unref: sinon.stub().returns(udp4),
    }

    dgram = {
      createSocket: sinon.stub(),
    }
    dgram.createSocket.withArgs('udp4').returns(udp4)
    dgram.createSocket.withArgs('udp6').returns(udp6)

    dns = {
      lookup: sinon.stub(),
    }

    dns.lookup.callsFake((hostname, callback) => {
      callback(new Error())
    })

    dns.lookup.withArgs('localhost').callsFake((hostname, callback) => {
      callback(null, '127.0.0.1', 4)
    })

    dns.lookup.withArgs('127.0.0.1').callsFake((hostname, callback) => {
      callback(null, hostname, 4)
    })

    dns.lookup.withArgs('::1').callsFake((hostname, callback) => {
      callback(null, hostname, 6)
    })

    docker = {}
    log = { debug: sinon.stub(), error: sinon.stub() }

    const dogstatsd = proxyquire.noPreserveCache().noCallThru()('../src/dogstatsd', {
      dgram,
      './exporters/common/docker': docker,
      './log': log,
    })
    DogStatsDClient = dogstatsd.DogStatsDClient
    CustomMetrics = dogstatsd.CustomMetrics
    MetricsAggregationClient = dogstatsd.MetricsAggregationClient

    httpData = []
    statusCode = 200
    assertData = undefined
    sockets = []
    httpServer = http.createServer((req, res) => {
      assert.strictEqual(req.method, 'POST')
      assert.strictEqual(req.url, '/dogstatsd/v2/proxy')
      req.on('data', d => httpData.push(d))
      req.on('end', () => {
        res.statusCode = statusCode
        res.end()
        setTimeout(() => assertData && assertData(httpData))
      })
    }).listen(0, () => {
      httpPort = httpServer.address().port
      if (os.platform() === 'win32') {
        done()
        return
      }
      udsPath = path.join(os.tmpdir(), `test-dogstatsd-dd-trace-uds-${Math.random()}`)
      httpUdsServer = http.createServer((req, res) => {
        assert.strictEqual(req.method, 'POST')
        assert.strictEqual(req.url, '/dogstatsd/v2/proxy')
        req.on('data', d => httpData.push(d))
        req.on('end', () => {
          res.end()
          setTimeout(() => assertData && assertData(httpData))
        })
      }).listen(udsPath, () => {
        done()
      })
      httpUdsServer.on('connection', socket => sockets.push(socket))
    })
    httpServer.on('connection', socket => sockets.push(socket))
  })

  afterEach(() => {
    httpServer.close()
    if (httpUdsServer) {
      httpUdsServer.close()
    }
    sockets.forEach(socket => socket.destroy())
  })

  function createDogStatsDClient (options) {
    return new DogStatsDClient({
      host: '127.0.0.1',
      lookup: dns.lookup,
      port: 8125,
      tags: [],
      ...options,
    })
  }

  function createCustomMetrics (CustomMetricsCtor = CustomMetrics) {
    return new CustomMetricsCtor({
      dogstatsd: {
        hostname: '127.0.0.1',
        port: 8125,
      },
      lookup: dns.lookup,
      runtimeMetricsRuntimeId: false,
    })
  }

  it('should send gauges', () => {
    client = createDogStatsDClient()

    client.gauge('test.avg', 10)
    client.flush()

    sinon.assert.called(udp4.send)
    assert.strictEqual(udp4.send.firstCall.args[0].toString(), 'test.avg:10|g\n')
    assert.strictEqual(udp4.send.firstCall.args[1], 0)
    assert.strictEqual(udp4.send.firstCall.args[2], 14)
    assert.strictEqual(udp4.send.firstCall.args[3], 8125)
    assert.strictEqual(udp4.send.firstCall.args[4], '127.0.0.1')
  })

  it('should send histograms', () => {
    client = createDogStatsDClient()

    client.histogram('test.histogram', 10)
    client.flush()

    sinon.assert.called(udp4.send)
    assert.strictEqual(udp4.send.firstCall.args[0].toString(), 'test.histogram:10|h\n')
    assert.strictEqual(udp4.send.firstCall.args[1], 0)
    assert.strictEqual(udp4.send.firstCall.args[2], 20)
    assert.strictEqual(udp4.send.firstCall.args[3], 8125)
    assert.strictEqual(udp4.send.firstCall.args[4], '127.0.0.1')
  })

  it('should send counters', () => {
    client = createDogStatsDClient()

    client.increment('test.count', 10)
    client.flush()

    sinon.assert.called(udp4.send)
    assert.strictEqual(udp4.send.firstCall.args[0].toString(), 'test.count:10|c\n')
    assert.strictEqual(udp4.send.firstCall.args[2], 16)
  })

  it('should send multiple metrics', () => {
    client = createDogStatsDClient()

    client.gauge('test.avg', 10)
    client.increment('test.count', 10)
    client.decrement('test.count', 5)
    client.flush()

    sinon.assert.called(udp4.send)
    assert.strictEqual(udp4.send.firstCall.args[0].toString(), 'test.avg:10|g\ntest.count:10|c\ntest.count:-5|c\n')
    assert.strictEqual(udp4.send.firstCall.args[2], 46)
  })

  it('should support tags', () => {
    client = createDogStatsDClient()

    client.gauge('test.avg', 10, ['foo:bar', 'baz:qux'])
    client.flush()

    sinon.assert.called(udp4.send)
    assert.strictEqual(udp4.send.firstCall.args[0].toString(), 'test.avg:10|g|#foo:bar,baz:qux\n')
    assert.strictEqual(udp4.send.firstCall.args[2], 31)
  })

  it('should buffer metrics', () => {
    const value = new Array(1000).map(() => 'a').join()
    const tags = [`foo:${value}`]

    client = createDogStatsDClient()

    client.gauge('test.avg', 1, tags)
    client.gauge('test.avg', 1, tags)
    client.flush()

    sinon.assert.calledTwice(udp4.send)
  })

  it('should not flush if the queue is empty', () => {
    client = createDogStatsDClient()

    client.flush()

    sinon.assert.notCalled(udp4.send)
    sinon.assert.notCalled(udp6.send)
    sinon.assert.notCalled(dns.lookup)
    sinon.assert.notCalled(log.debug)
  })

  it('logs the metric count and the UDP transport on a non-empty flush', () => {
    client = createDogStatsDClient()

    client.gauge('test.avg', 1)
    client.flush()

    assert.deepStrictEqual(log.debug.firstCall.args, ['Flushing %s metrics via %s', 1, 'UDP'])
  })

  it('logs the metric count and the HTTP transport on a non-empty flush', () => {
    client = createDogStatsDClient({
      metricsProxyUrl: `http://localhost:${httpPort}`,
    })

    client.gauge('test.avg', 1)
    client.flush()

    assert.deepStrictEqual(log.debug.firstCall.args, ['Flushing %s metrics via %s', 1, 'HTTP'])
  })

  it('should not flush if the dns lookup fails', () => {
    client = createDogStatsDClient({
      host: 'invalid',
    })

    client.gauge('test.avg', 1)
    client.flush()

    sinon.assert.called(dns.lookup)
    sinon.assert.notCalled(udp4.send)
    sinon.assert.notCalled(udp6.send)
  })

  it('should not call DNS if the host is an IPv4 address', () => {
    client = createDogStatsDClient({
      host: '127.0.0.1',
    })

    client.gauge('test.avg', 1)
    client.flush()

    sinon.assert.called(udp4.send)
    sinon.assert.notCalled(dns.lookup)
  })

  it('should not call DNS if the host is an IPv6 address', () => {
    client = createDogStatsDClient({
      host: '2001:db8:3333:4444:5555:6666:7777:8888',
    })

    client.gauge('test.avg', 1)
    client.flush()

    sinon.assert.called(udp6.send)
    sinon.assert.notCalled(dns.lookup)
  })

  it('should support configuration', () => {
    client = createDogStatsDClient({
      host: '::1',
      port: 7777,
      tags: ['foo:bar'],
    })

    client.gauge('test.avg', 1, ['baz:qux'])
    client.flush()

    sinon.assert.called(udp6.send)
    assert.strictEqual(udp6.send.firstCall.args[0].toString(), 'test.avg:1|g|#foo:bar,baz:qux\n')
    assert.strictEqual(udp6.send.firstCall.args[1], 0)
    assert.strictEqual(udp6.send.firstCall.args[2], 30)
    assert.strictEqual(udp6.send.firstCall.args[3], 7777)
    assert.strictEqual(udp6.send.firstCall.args[4], '::1')
  })

  const udsIt = os.platform() === 'win32' ? it.skip : it
  udsIt('should support HTTP via unix domain socket', (done) => {
    assertData = () => {
      try {
        assert.strictEqual(Buffer.concat(httpData).toString(), 'test.avg:0|g\ntest.avg2:2|g\n')
        done()
      } catch (e) {
        done(e)
      }
    }

    client = createDogStatsDClient({
      metricsProxyUrl: `unix://${udsPath}`,
    })

    client.gauge('test.avg', 0)
    client.gauge('test.avg2', 2)
    client.flush()
  })

  it('should support HTTP via port', (done) => {
    assertData = () => {
      try {
        assert.strictEqual(Buffer.concat(httpData).toString(), 'test.avg:1|g\ntest.avg2:2|g\n')
        done()
      } catch (e) {
        done(e)
      }
    }

    client = createDogStatsDClient({
      metricsProxyUrl: `http://localhost:${httpPort}`,
    })

    client.gauge('test.avg', 1)
    client.gauge('test.avg2', 2)
    client.flush()
  })

  it('should support HTTP via URL object', (done) => {
    assertData = () => {
      try {
        assert.strictEqual(Buffer.concat(httpData).toString(), 'test.avg:1|g\ntest.avg2:2|g\n')
        done()
      } catch (e) {
        done(e)
      }
    }

    client = createDogStatsDClient({
      metricsProxyUrl: new URL(`http://localhost:${httpPort}`),
    })

    client.gauge('test.avg', 1)
    client.gauge('test.avg2', 2)
    client.flush()
  })

  it('should fail over to UDP when receiving HTTP 404 error from agent', (done) => {
    assertData = () => {
      setTimeout(() => {
        try {
          sinon.assert.called(udp4.send)
          assert.strictEqual(udp4.send.firstCall.args[0].toString(), 'test.count:10|c\n')
          assert.strictEqual(udp4.send.firstCall.args[2], 16)
          done()
        } catch (e) {
          done(e)
        }
      })
    }

    statusCode = 404

    client = createDogStatsDClient({
      metricsProxyUrl: `http://localhost:${httpPort}`,
    })

    client.increment('test.count', 10)

    client.flush()
  })

  it('should fail over to UDP when receiving network error from agent', (done) => {
    udp4.send = sinon.stub().callsFake(() => {
      try {
        sinon.assert.called(udp4.send)
        assert.strictEqual(udp4.send.firstCall.args[0].toString(), 'test.foo:10|c\n')
        assert.strictEqual(udp4.send.firstCall.args[2], 14)
        done()
      } catch (e) {
        done(e)
      }
    })

    statusCode = null

    // host exists but port does not, ECONNREFUSED
    client = createDogStatsDClient({
      metricsProxyUrl: 'http://localhost:32700',
      host: 'localhost',
      port: 8125,
    })

    client.increment('test.foo', 10)

    client.flush()
  })

  describe('CustomMetrics', () => {
    it('.gauge()', () => {
      client = createCustomMetrics()

      client.gauge('test.avg', 10, { foo: 'bar' })
      client.gauge('test.avg', 10, { foo: 'bar' })
      client.flush()

      sinon.assert.called(udp4.send)
      assert.strictEqual(udp4.send.firstCall.args[0].toString(), 'test.avg:10|g|#foo:bar\n')
    })

    it('.gauge() with tags', () => {
      client = createCustomMetrics()

      client.gauge('test.avg', 10, { foo: 'bar' })
      client.gauge('test.avg', 10, { foo: 'bar', baz: 'qux' })
      client.gauge('test.avg', 20, { foo: 'bar', baz: 'qux' })
      client.flush()

      sinon.assert.called(udp4.send)
      assert.strictEqual(udp4.send.firstCall.args[0].toString(), [
        'test.avg:10|g|#foo:bar',
        'test.avg:20|g|#foo:bar,baz:qux',
      ].join('\n') + '\n')
    })

    it('.increment()', () => {
      client = createCustomMetrics()

      client.increment('test.count', 10)
      client.increment('test.count', 10)
      client.flush()

      sinon.assert.called(udp4.send)
      assert.strictEqual(udp4.send.firstCall.args[0].toString(), 'test.count:20|c\n')
    })

    it('.increment() with default', () => {
      client = createCustomMetrics()

      client.increment('test.count')
      client.increment('test.count')
      client.flush()

      sinon.assert.called(udp4.send)
      assert.strictEqual(udp4.send.firstCall.args[0].toString(), 'test.count:2|c\n')
    })

    it('.increment() with tags', () => {
      client = createCustomMetrics()

      client.increment('test.count', 10, { foo: 'bar' })
      client.increment('test.count', 10, { foo: 'bar', baz: 'qux' })
      client.increment('test.count', 10, { foo: 'bar', baz: 'qux' })
      client.flush()

      sinon.assert.called(udp4.send)
      assert.strictEqual(udp4.send.firstCall.args[0].toString(), [
        'test.count:10|c|#foo:bar',
        'test.count:20|c|#foo:bar,baz:qux',
      ].join('\n') + '\n')
    })

    it('.decrement()', () => {
      client = createCustomMetrics()

      client.decrement('test.count', 10)
      client.decrement('test.count', 10)
      client.flush()

      sinon.assert.called(udp4.send)
      assert.strictEqual(udp4.send.firstCall.args[0].toString(), 'test.count:-20|c\n')
    })

    it('.decrement() with default', () => {
      client = createCustomMetrics()

      client.decrement('test.count')
      client.decrement('test.count')
      client.flush()

      sinon.assert.called(udp4.send)
      assert.strictEqual(udp4.send.firstCall.args[0].toString(), 'test.count:-2|c\n')
    })

    it('.distribution()', () => {
      client = createCustomMetrics()

      client.distribution('test.dist', 10)
      client.distribution('test.dist', 10)
      client.flush()

      sinon.assert.called(udp4.send)
      assert.strictEqual(udp4.send.firstCall.args[0].toString(), 'test.dist:10|d\ntest.dist:10|d\n')
    })

    it('.histogram()', () => {
      client = createCustomMetrics()

      client.histogram('test.histogram', 10)
      client.histogram('test.histogram', 10)
      client.flush()

      sinon.assert.called(udp4.send)
      assert.strictEqual(udp4.send.firstCall.args[0].toString(), [
        'test.histogram.min:10|g',
        'test.histogram.max:10|g',
        'test.histogram.sum:20|c',
        'test.histogram.total:20|c',
        'test.histogram.avg:10|g',
        'test.histogram.count:2|c',
        'test.histogram.median:10.074696689511441|g',
        'test.histogram.95percentile:10.074696689511441|g',
      ].join('\n') + '\n')
    })

    it('.histogram() with tags', () => {
      client = createCustomMetrics()

      client.histogram('test.histogram', 10, { foo: 'bar' })
      client.histogram('test.histogram', 10, { foo: 'bar', baz: 'qux' })
      client.histogram('test.histogram', 10, { foo: 'bar', baz: 'qux' })
      client.flush()

      sinon.assert.called(udp4.send)
      assert.strictEqual(udp4.send.firstCall.args[0].toString(), [
        'test.histogram.min:10|g|#foo:bar',
        'test.histogram.max:10|g|#foo:bar',
        'test.histogram.sum:10|c|#foo:bar',
        'test.histogram.total:10|c|#foo:bar',
        'test.histogram.avg:10|g|#foo:bar',
        'test.histogram.count:1|c|#foo:bar',
        'test.histogram.median:10.074696689511441|g|#foo:bar',
        'test.histogram.95percentile:10.074696689511441|g|#foo:bar',
        'test.histogram.min:10|g|#foo:bar,baz:qux',
        'test.histogram.max:10|g|#foo:bar,baz:qux',
        'test.histogram.sum:20|c|#foo:bar,baz:qux',
        'test.histogram.total:20|c|#foo:bar,baz:qux',
        'test.histogram.avg:10|g|#foo:bar,baz:qux',
        'test.histogram.count:2|c|#foo:bar,baz:qux',
        'test.histogram.median:10.074696689511441|g|#foo:bar,baz:qux',
        'test.histogram.95percentile:10.074696689511441|g|#foo:bar,baz:qux',
      ].join('\n') + '\n')
    })

    it('should support array-based tags for gauge', () => {
      client = createCustomMetrics()

      client.gauge('test.avg', 10, ['foo:bar', 'baz:qux'])
      client.flush()

      sinon.assert.called(udp4.send)
      assert.strictEqual(udp4.send.firstCall.args[0].toString(), 'test.avg:10|g|#foo:bar,baz:qux\n')
    })

    it('should support array-based tags for increment', () => {
      client = createCustomMetrics()

      client.increment('test.count', 10, ['foo:bar', 'baz:qux'])
      client.flush()

      sinon.assert.called(udp4.send)
      assert.strictEqual(udp4.send.firstCall.args[0].toString(), 'test.count:10|c|#foo:bar,baz:qux\n')
    })

    it('should support array-based tags for decrement', () => {
      client = createCustomMetrics()

      client.decrement('test.count', 10, ['foo:bar', 'baz:qux'])
      client.flush()

      sinon.assert.called(udp4.send)
      assert.strictEqual(udp4.send.firstCall.args[0].toString(), 'test.count:-10|c|#foo:bar,baz:qux\n')
    })

    it('should support array-based tags for distribution', () => {
      client = createCustomMetrics()

      client.distribution('test.dist', 10, ['foo:bar', 'baz:qux'])
      client.flush()

      sinon.assert.called(udp4.send)
      assert.strictEqual(udp4.send.firstCall.args[0].toString(), 'test.dist:10|d|#foo:bar,baz:qux\n')
    })

    it('should support array-based tags for histogram', () => {
      client = createCustomMetrics()

      client.histogram('test.histogram', 10, ['foo:bar', 'baz:qux'])
      client.flush()

      sinon.assert.called(udp4.send)
      assert.strictEqual(udp4.send.firstCall.args[0].toString(), [
        'test.histogram.min:10|g|#foo:bar,baz:qux',
        'test.histogram.max:10|g|#foo:bar,baz:qux',
        'test.histogram.sum:10|c|#foo:bar,baz:qux',
        'test.histogram.total:10|c|#foo:bar,baz:qux',
        'test.histogram.avg:10|g|#foo:bar,baz:qux',
        'test.histogram.count:1|c|#foo:bar,baz:qux',
        'test.histogram.median:10.074696689511441|g|#foo:bar,baz:qux',
        'test.histogram.95percentile:10.074696689511441|g|#foo:bar,baz:qux',
      ].join('\n') + '\n')
    })

    it('should handle empty array of tags', () => {
      client = createCustomMetrics()

      client.gauge('test.avg', 10, [])
      client.flush()

      sinon.assert.called(udp4.send)
      assert.strictEqual(udp4.send.firstCall.args[0].toString(), 'test.avg:10|g\n')
    })

    it('should handle mixed tag formats', () => {
      client = createCustomMetrics()

      client.gauge('test.avg', 10, { foo: 'bar' })
      client.gauge('test.avg', 20, ['baz:qux'])
      client.flush()

      sinon.assert.called(udp4.send)
      assert.strictEqual(udp4.send.firstCall.args[0].toString(), [
        'test.avg:10|g|#foo:bar',
        'test.avg:20|g|#baz:qux',
      ].join('\n') + '\n')
    })

    it('should flush via interval', () => {
      const clock = sinon.useFakeTimers({
        toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
      })

      try {
        client = createCustomMetrics()

        client.gauge('test.avg', 10, { foo: 'bar' })

        sinon.assert.notCalled(udp4.send)

        clock.tick(10 * 1000)

        sinon.assert.called(udp4.send)
        assert.strictEqual(udp4.send.firstCall.args[0].toString(), 'test.avg:10|g|#foo:bar\n')
      } finally {
        clock.restore()
      }
    })

    it('should send the Docker entity ID when available', () => {
      docker.entityId = 'ci-1234'

      const { CustomMetrics } = proxyquire.noPreserveCache()('../src/dogstatsd', {
        dgram,
        './exporters/common/docker': docker,
      })

      client = createCustomMetrics(CustomMetrics)

      client.gauge('test.avg', 10, { foo: 'bar' })
      client.flush()

      sinon.assert.called(udp4.send)
      assert.strictEqual(udp4.send.firstCall.args[0].toString(), 'test.avg:10|g|#foo:bar|c:ci-1234\n')
    })
  })

  describe('MetricsAggregationClient', () => {
    let aggregator
    let gaugeCalls
    let incrementCalls

    beforeEach(() => {
      gaugeCalls = []
      incrementCalls = []
      const inner = {
        gauge: (name, value, tags) => gaugeCalls.push([name, value, tags?.slice()]),
        increment: (name, value, tags) => incrementCalls.push([name, value, tags?.slice()]),
        distribution: () => {},
        histogram: () => {},
        flush: () => {},
      }
      aggregator = new MetricsAggregationClient(inner)
    })

    it('emits a gauge once and then stays silent until it is set again', () => {
      aggregator.gauge('test.avg', 5)
      aggregator.flush()

      assert.deepStrictEqual(gaugeCalls, [['test.avg', 5, []]])

      gaugeCalls.length = 0
      aggregator.flush()
      aggregator.flush()

      assert.deepStrictEqual(gaugeCalls, [])
    })

    it('re-emits a gauge on every flush when it is updated each cycle', () => {
      for (let i = 1; i <= 3; i++) {
        aggregator.gauge('test.avg', i)
        aggregator.flush()
      }

      assert.deepStrictEqual(gaugeCalls, [
        ['test.avg', 1, []],
        ['test.avg', 2, []],
        ['test.avg', 3, []],
      ])
    })

    it('does not re-emit a histogram once observations stop', () => {
      aggregator.histogram('test.hist', 10)
      aggregator.flush()

      assert(gaugeCalls.length > 0 && incrementCalls.length > 0)

      gaugeCalls.length = 0
      incrementCalls.length = 0
      aggregator.flush()
      aggregator.flush()

      assert.deepStrictEqual(gaugeCalls, [])
      assert.deepStrictEqual(incrementCalls, [])
    })

    it('drains all metric trees on flush so cardinality is bounded', () => {
      aggregator.gauge('test.avg', 5, ['t:1'])
      aggregator.histogram('test.hist', 10, ['t:1'])
      aggregator.increment('test.count', 1, ['t:1'])
      aggregator.flush()

      assert.strictEqual(aggregator._gauges.size, 0)
      assert.strictEqual(aggregator._histograms.size, 0)
      assert.strictEqual(aggregator._counters.size, 0)
    })
  })
})
