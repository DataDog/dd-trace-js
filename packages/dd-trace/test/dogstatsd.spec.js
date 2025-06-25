'use strict'

const t = require('tap')
require('./setup/core')

const http = require('http')
const path = require('path')
const os = require('os')

t.test('dogstatsd', t => {
  let client
  let DogStatsDClient
  let CustomMetrics
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

  t.beforeEach(async () => {
    udp6 = {
      send: sinon.spy(),
      on: sinon.stub().returns(udp6),
      unref: sinon.stub().returns(udp6)
    }

    udp4 = {
      send: sinon.spy(),
      on: sinon.stub().returns(udp4),
      unref: sinon.stub().returns(udp4)
    }

    dgram = {
      createSocket: sinon.stub()
    }
    dgram.createSocket.withArgs('udp4').returns(udp4)
    dgram.createSocket.withArgs('udp6').returns(udp6)

    dns = {
      lookup: sinon.stub()
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

    const dogstatsd = proxyquire('../src/dogstatsd', {
      dgram,
      dns
    })
    DogStatsDClient = dogstatsd.DogStatsDClient
    CustomMetrics = dogstatsd.CustomMetrics

    httpData = []
    statusCode = 200
    assertData = undefined
    sockets = []
    httpServer = http.createServer((req, res) => {
      expect(req.url).to.equal('/dogstatsd/v2/proxy')
      req.on('data', d => httpData.push(d))
      req.on('end', () => {
        res.statusCode = statusCode
        res.end()
        setTimeout(() => assertData && assertData(httpData))
      })
    }).listen(0, () => {
      httpPort = httpServer.address().port
      if (os.platform() === 'win32') {
        t.end()
        return
      }
      udsPath = path.join(os.tmpdir(), `test-dogstatsd-dd-trace-uds-${Math.random()}`)
      httpUdsServer = http.createServer((req, res) => {
        expect(req.url).to.equal('/dogstatsd/v2/proxy')
        req.on('data', d => httpData.push(d))
        req.on('end', () => {
          res.end()
          setTimeout(() => assertData && assertData(httpData))
        })
      }).listen(udsPath, () => {
        t.end()
      })
      httpUdsServer.on('connection', socket => sockets.push(socket))
    })
    httpServer.on('connection', socket => sockets.push(socket))
  })

  t.afterEach(() => {
    httpServer.close()
    if (httpUdsServer) {
      httpUdsServer.close()
    }
    sockets.forEach(socket => socket.destroy())
  })

  t.test('should send gauges', t => {
    client = new DogStatsDClient()

    client.gauge('test.avg', 10)
    client.flush()

    expect(udp4.send).to.have.been.called
    expect(udp4.send.firstCall.args[0].toString()).to.equal('test.avg:10|g\n')
    expect(udp4.send.firstCall.args[1]).to.equal(0)
    expect(udp4.send.firstCall.args[2]).to.equal(14)
    expect(udp4.send.firstCall.args[3]).to.equal(8125)
    expect(udp4.send.firstCall.args[4]).to.equal('127.0.0.1')
    t.end()
  })

  t.test('should send histograms', t => {
    client = new DogStatsDClient()

    client.histogram('test.histogram', 10)
    client.flush()

    expect(udp4.send).to.have.been.called
    expect(udp4.send.firstCall.args[0].toString()).to.equal('test.histogram:10|h\n')
    expect(udp4.send.firstCall.args[1]).to.equal(0)
    expect(udp4.send.firstCall.args[2]).to.equal(20)
    expect(udp4.send.firstCall.args[3]).to.equal(8125)
    expect(udp4.send.firstCall.args[4]).to.equal('127.0.0.1')
    t.end()
  })

  t.test('should send counters', t => {
    client = new DogStatsDClient()

    client.increment('test.count', 10)
    client.flush()

    expect(udp4.send).to.have.been.called
    expect(udp4.send.firstCall.args[0].toString()).to.equal('test.count:10|c\n')
    expect(udp4.send.firstCall.args[2]).to.equal(16)
    t.end()
  })

  t.test('should send multiple metrics', t => {
    client = new DogStatsDClient()

    client.gauge('test.avg', 10)
    client.increment('test.count', 10)
    client.decrement('test.count', 5)
    client.flush()

    expect(udp4.send).to.have.been.called
    expect(udp4.send.firstCall.args[0].toString()).to.equal('test.avg:10|g\ntest.count:10|c\ntest.count:-5|c\n')
    expect(udp4.send.firstCall.args[2]).to.equal(46)
    t.end()
  })

  t.test('should support tags', t => {
    client = new DogStatsDClient()

    client.gauge('test.avg', 10, ['foo:bar', 'baz:qux'])
    client.flush()

    expect(udp4.send).to.have.been.called
    expect(udp4.send.firstCall.args[0].toString()).to.equal('test.avg:10|g|#foo:bar,baz:qux\n')
    expect(udp4.send.firstCall.args[2]).to.equal(31)
    t.end()
  })

  t.test('should buffer metrics', t => {
    const value = new Array(1000).map(() => 'a').join()
    const tags = [`foo:${value}`]

    client = new DogStatsDClient()

    client.gauge('test.avg', 1, tags)
    client.gauge('test.avg', 1, tags)
    client.flush()

    expect(udp4.send).to.have.been.calledTwice
    t.end()
  })

  t.test('should not flush if the queue is empty', t => {
    client = new DogStatsDClient()

    client.flush()

    expect(udp4.send).to.not.have.been.called
    expect(udp6.send).to.not.have.been.called
    expect(dns.lookup).to.not.have.been.called
    t.end()
  })

  t.test('should not flush if the dns lookup fails', t => {
    client = new DogStatsDClient({
      host: 'invalid'
    })

    client.gauge('test.avg', 1)
    client.flush()

    expect(dns.lookup).to.have.been.called
    expect(udp4.send).to.not.have.been.called
    expect(udp6.send).to.not.have.been.called
    t.end()
  })

  t.test('should not call DNS if the host is an IPv4 address', t => {
    client = new DogStatsDClient({
      host: '127.0.0.1'
    })

    client.gauge('test.avg', 1)
    client.flush()

    expect(udp4.send).to.have.been.called
    expect(dns.lookup).to.not.have.been.called
    t.end()
  })

  t.test('should not call DNS if the host is an IPv6 address', t => {
    client = new DogStatsDClient({
      host: '2001:db8:3333:4444:5555:6666:7777:8888'
    })

    client.gauge('test.avg', 1)
    client.flush()

    expect(udp6.send).to.have.been.called
    expect(dns.lookup).to.not.have.been.called
    t.end()
  })

  t.test('should support configuration', t => {
    client = new DogStatsDClient({
      host: '::1',
      port: 7777,
      prefix: 'prefix.',
      tags: ['foo:bar']
    })

    client.gauge('test.avg', 1, ['baz:qux'])
    client.flush()

    expect(udp6.send).to.have.been.called
    expect(udp6.send.firstCall.args[0].toString()).to.equal('prefix.test.avg:1|g|#foo:bar,baz:qux\n')
    expect(udp6.send.firstCall.args[1]).to.equal(0)
    expect(udp6.send.firstCall.args[2]).to.equal(37)
    expect(udp6.send.firstCall.args[3]).to.equal(7777)
    expect(udp6.send.firstCall.args[4]).to.equal('::1')
    t.end()
  })

  const udsIt = os.platform() === 'win32' ? it.skip : it
  udsIt('should support HTTP via unix domain socket', (done) => {
    assertData = () => {
      try {
        expect(Buffer.concat(httpData).toString()).to.equal('test.avg:0|g\ntest.avg2:2|g\n')
        t.end()
      } catch (e) {
        t.error(e)
        t.end()
      }
    }

    client = new DogStatsDClient({
      metricsProxyUrl: `unix://${udsPath}`
    })

    client.gauge('test.avg', 0)
    client.gauge('test.avg2', 2)
    client.flush()
  })

  t.test('should support HTTP via port', (t) => {
    assertData = () => {
      try {
        expect(Buffer.concat(httpData).toString()).to.equal('test.avg:1|g\ntest.avg2:2|g\n')
        t.end()
      } catch (e) {
        t.error(e)
        t.end()
      }
    }

    client = new DogStatsDClient({
      metricsProxyUrl: `http://localhost:${httpPort}`
    })

    client.gauge('test.avg', 1)
    client.gauge('test.avg2', 2)
    client.flush()
  })

  t.test('should support HTTP via URL object', (t) => {
    assertData = () => {
      try {
        expect(Buffer.concat(httpData).toString()).to.equal('test.avg:1|g\ntest.avg2:2|g\n')
        t.end()
      } catch (e) {
        t.error(e)
        t.end()
      }
    }

    client = new DogStatsDClient({
      metricsProxyUrl: new URL(`http://localhost:${httpPort}`)
    })

    client.gauge('test.avg', 1)
    client.gauge('test.avg2', 2)
    client.flush()
  })

  t.test('should fail over to UDP when receiving HTTP 404 error from agent', (t) => {
    assertData = () => {
      setTimeout(() => {
        try {
          expect(udp4.send).to.have.been.called
          expect(udp4.send.firstCall.args[0].toString()).to.equal('test.count:10|c\n')
          expect(udp4.send.firstCall.args[2]).to.equal(16)
          t.end()
        } catch (e) {
          t.error(e)
          t.end()
        }
      })
    }

    statusCode = 404

    client = new DogStatsDClient({
      metricsProxyUrl: `http://localhost:${httpPort}`
    })

    client.increment('test.count', 10)

    client.flush()
  })

  t.test('should fail over to UDP when receiving network error from agent', (t) => {
    udp4.send = sinon.stub().callsFake(() => {
      try {
        expect(udp4.send).to.have.been.called
        expect(udp4.send.firstCall.args[0].toString()).to.equal('test.foo:10|c\n')
        expect(udp4.send.firstCall.args[2]).to.equal(14)
        t.end()
      } catch (e) {
        t.error(e)
        t.end()
      }
    })

    statusCode = null

    // host exists but port does not, ECONNREFUSED
    client = new DogStatsDClient({
      metricsProxyUrl: 'http://localhost:32700',
      host: 'localhost',
      port: 8125
    })

    client.increment('test.foo', 10)

    client.flush()
  })

  t.test('CustomMetrics', t => {
    t.test('.gauge()', t => {
      client = new CustomMetrics({ dogstatsd: {} })

      client.gauge('test.avg', 10, { foo: 'bar' })
      client.gauge('test.avg', 10, { foo: 'bar' })
      client.flush()

      expect(udp4.send).to.have.been.called
      expect(udp4.send.firstCall.args[0].toString()).to.equal('test.avg:10|g|#foo:bar\n')
      t.end()
    })

    t.test('.gauge() with tags', t => {
      client = new CustomMetrics({ dogstatsd: {} })

      client.gauge('test.avg', 10, { foo: 'bar' })
      client.gauge('test.avg', 10, { foo: 'bar', baz: 'qux' })
      client.gauge('test.avg', 20, { foo: 'bar', baz: 'qux' })
      client.flush()

      expect(udp4.send).to.have.been.called
      expect(udp4.send.firstCall.args[0].toString()).to.equal([
        'test.avg:10|g|#foo:bar',
        'test.avg:20|g|#foo:bar,baz:qux'
      ].join('\n') + '\n')
      t.end()
    })

    t.test('.increment()', t => {
      client = new CustomMetrics({ dogstatsd: {} })

      client.increment('test.count', 10)
      client.increment('test.count', 10)
      client.flush()

      expect(udp4.send).to.have.been.called
      expect(udp4.send.firstCall.args[0].toString()).to.equal('test.count:20|c\n')
      t.end()
    })

    t.test('.increment() with default', t => {
      client = new CustomMetrics({ dogstatsd: {} })

      client.increment('test.count')
      client.increment('test.count')
      client.flush()

      expect(udp4.send).to.have.been.called
      expect(udp4.send.firstCall.args[0].toString()).to.equal('test.count:2|c\n')
      t.end()
    })

    t.test('.increment() with tags', t => {
      client = new CustomMetrics({ dogstatsd: {} })

      client.increment('test.count', 10, { foo: 'bar' })
      client.increment('test.count', 10, { foo: 'bar', baz: 'qux' })
      client.increment('test.count', 10, { foo: 'bar', baz: 'qux' })
      client.flush()

      expect(udp4.send).to.have.been.called
      expect(udp4.send.firstCall.args[0].toString()).to.equal([
        'test.count:10|c|#foo:bar',
        'test.count:20|c|#foo:bar,baz:qux'
      ].join('\n') + '\n')
      t.end()
    })

    t.test('.decrement()', t => {
      client = new CustomMetrics({ dogstatsd: {} })

      client.decrement('test.count', 10)
      client.decrement('test.count', 10)
      client.flush()

      expect(udp4.send).to.have.been.called
      expect(udp4.send.firstCall.args[0].toString()).to.equal('test.count:-20|c\n')
      t.end()
    })

    t.test('.decrement() with default', t => {
      client = new CustomMetrics({ dogstatsd: {} })

      client.decrement('test.count')
      client.decrement('test.count')
      client.flush()

      expect(udp4.send).to.have.been.called
      expect(udp4.send.firstCall.args[0].toString()).to.equal('test.count:-2|c\n')
      t.end()
    })

    t.test('.distribution()', t => {
      client = new CustomMetrics({ dogstatsd: {} })

      client.distribution('test.dist', 10)
      client.distribution('test.dist', 10)
      client.flush()

      expect(udp4.send).to.have.been.called
      expect(udp4.send.firstCall.args[0].toString()).to.equal('test.dist:10|d\ntest.dist:10|d\n')
      t.end()
    })

    t.test('.histogram()', t => {
      client = new CustomMetrics({ dogstatsd: {} })

      client.histogram('test.histogram', 10)
      client.histogram('test.histogram', 10)
      client.flush()

      expect(udp4.send).to.have.been.called
      expect(udp4.send.firstCall.args[0].toString()).to.equal([
        'test.histogram.min:10|g',
        'test.histogram.max:10|g',
        'test.histogram.sum:20|c',
        'test.histogram.total:20|c',
        'test.histogram.avg:10|g',
        'test.histogram.count:2|c',
        'test.histogram.median:10.074696689511441|g',
        'test.histogram.95percentile:10.074696689511441|g'
      ].join('\n') + '\n')
      t.end()
    })

    t.test('.histogram() with tags', t => {
      client = new CustomMetrics({ dogstatsd: {} })

      client.histogram('test.histogram', 10, { foo: 'bar' })
      client.histogram('test.histogram', 10, { foo: 'bar', baz: 'qux' })
      client.histogram('test.histogram', 10, { foo: 'bar', baz: 'qux' })
      client.flush()

      expect(udp4.send).to.have.been.called
      expect(udp4.send.firstCall.args[0].toString()).to.equal([
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
        'test.histogram.95percentile:10.074696689511441|g|#foo:bar,baz:qux'
      ].join('\n') + '\n')
      t.end()
    })

    t.test('should support array-based tags for gauge', t => {
      client = new CustomMetrics({ dogstatsd: {} })

      client.gauge('test.avg', 10, ['foo:bar', 'baz:qux'])
      client.flush()

      expect(udp4.send).to.have.been.called
      expect(udp4.send.firstCall.args[0].toString()).to.equal('test.avg:10|g|#foo:bar,baz:qux\n')
      t.end()
    })

    t.test('should support array-based tags for increment', t => {
      client = new CustomMetrics({ dogstatsd: {} })

      client.increment('test.count', 10, ['foo:bar', 'baz:qux'])
      client.flush()

      expect(udp4.send).to.have.been.called
      expect(udp4.send.firstCall.args[0].toString()).to.equal('test.count:10|c|#foo:bar,baz:qux\n')
      t.end()
    })

    t.test('should support array-based tags for decrement', t => {
      client = new CustomMetrics({ dogstatsd: {} })

      client.decrement('test.count', 10, ['foo:bar', 'baz:qux'])
      client.flush()

      expect(udp4.send).to.have.been.called
      expect(udp4.send.firstCall.args[0].toString()).to.equal('test.count:-10|c|#foo:bar,baz:qux\n')
      t.end()
    })

    t.test('should support array-based tags for distribution', t => {
      client = new CustomMetrics({ dogstatsd: {} })

      client.distribution('test.dist', 10, ['foo:bar', 'baz:qux'])
      client.flush()

      expect(udp4.send).to.have.been.called
      expect(udp4.send.firstCall.args[0].toString()).to.equal('test.dist:10|d|#foo:bar,baz:qux\n')
      t.end()
    })

    t.test('should support array-based tags for histogram', t => {
      client = new CustomMetrics({ dogstatsd: {} })

      client.histogram('test.histogram', 10, ['foo:bar', 'baz:qux'])
      client.flush()

      expect(udp4.send).to.have.been.called
      expect(udp4.send.firstCall.args[0].toString()).to.equal([
        'test.histogram.min:10|g|#foo:bar,baz:qux',
        'test.histogram.max:10|g|#foo:bar,baz:qux',
        'test.histogram.sum:10|c|#foo:bar,baz:qux',
        'test.histogram.total:10|c|#foo:bar,baz:qux',
        'test.histogram.avg:10|g|#foo:bar,baz:qux',
        'test.histogram.count:1|c|#foo:bar,baz:qux',
        'test.histogram.median:10.074696689511441|g|#foo:bar,baz:qux',
        'test.histogram.95percentile:10.074696689511441|g|#foo:bar,baz:qux'
      ].join('\n') + '\n')
      t.end()
    })

    t.test('should handle empty array of tags', t => {
      client = new CustomMetrics({ dogstatsd: {} })

      client.gauge('test.avg', 10, [])
      client.flush()

      expect(udp4.send).to.have.been.called
      expect(udp4.send.firstCall.args[0].toString()).to.equal('test.avg:10|g\n')
      t.end()
    })

    t.test('should handle mixed tag formats', t => {
      client = new CustomMetrics({ dogstatsd: {} })

      client.gauge('test.avg', 10, { foo: 'bar' })
      client.gauge('test.avg', 20, ['baz:qux'])
      client.flush()

      expect(udp4.send).to.have.been.called
      expect(udp4.send.firstCall.args[0].toString()).to.equal([
        'test.avg:10|g|#foo:bar',
        'test.avg:20|g|#baz:qux'
      ].join('\n') + '\n')
      t.end()
    })

    t.test('should flush via interval', t => {
      const clock = sinon.useFakeTimers()

      client = new CustomMetrics({ dogstatsd: {} })

      client.gauge('test.avg', 10, { foo: 'bar' })

      expect(udp4.send).not.to.have.been.called

      clock.tick(10 * 1000)

      expect(udp4.send).to.have.been.called
      expect(udp4.send.firstCall.args[0].toString()).to.equal('test.avg:10|g|#foo:bar\n')
      t.end()
    })
    t.end()
  })
  t.end()
})
