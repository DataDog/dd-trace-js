'use strict'

require('./setup/tap')

const http = require('http')
const path = require('path')
const os = require('os')

describe('dogstatsd', () => {
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

  beforeEach((done) => {
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
      'dgram': dgram,
      'dns': dns
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
        done()
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

  it('should send gauges', () => {
    client = new DogStatsDClient()

    client.gauge('test.avg', 10)
    client.flush()

    expect(udp4.send).to.have.been.called
    expect(udp4.send.firstCall.args[0].toString()).to.equal('test.avg:10|g\n')
    expect(udp4.send.firstCall.args[1]).to.equal(0)
    expect(udp4.send.firstCall.args[2]).to.equal(14)
    expect(udp4.send.firstCall.args[3]).to.equal(8125)
    expect(udp4.send.firstCall.args[4]).to.equal('127.0.0.1')
  })

  it('should send counters', () => {
    client = new DogStatsDClient()

    client.increment('test.count', 10)
    client.flush()

    expect(udp4.send).to.have.been.called
    expect(udp4.send.firstCall.args[0].toString()).to.equal('test.count:10|c\n')
    expect(udp4.send.firstCall.args[2]).to.equal(16)
  })

  it('should send multiple metrics', () => {
    client = new DogStatsDClient()

    client.gauge('test.avg', 10)
    client.increment('test.count', 10)
    client.flush()

    expect(udp4.send).to.have.been.called
    expect(udp4.send.firstCall.args[0].toString()).to.equal('test.avg:10|g\ntest.count:10|c\n')
    expect(udp4.send.firstCall.args[2]).to.equal(30)
  })

  it('should support tags', () => {
    client = new DogStatsDClient()

    client.gauge('test.avg', 10, ['foo:bar', 'baz:qux'])
    client.flush()

    expect(udp4.send).to.have.been.called
    expect(udp4.send.firstCall.args[0].toString()).to.equal('test.avg:10|g|#foo:bar,baz:qux\n')
    expect(udp4.send.firstCall.args[2]).to.equal(31)
  })

  it('should buffer metrics', () => {
    const value = new Array(1000).map(() => 'a').join()
    const tags = [`foo:${value}`]

    client = new DogStatsDClient()

    client.gauge('test.avg', 1, tags)
    client.gauge('test.avg', 1, tags)
    client.flush()

    expect(udp4.send).to.have.been.calledTwice
  })

  it('should not flush if the queue is empty', () => {
    client = new DogStatsDClient()

    client.flush()

    expect(udp4.send).to.not.have.been.called
    expect(udp6.send).to.not.have.been.called
    expect(dns.lookup).to.not.have.been.called
  })

  it('should not flush if the dns lookup fails', () => {
    client = new DogStatsDClient({
      host: 'invalid'
    })

    client.gauge('test.avg', 1)
    client.flush()

    expect(dns.lookup).to.have.been.called
    expect(udp4.send).to.not.have.been.called
    expect(udp6.send).to.not.have.been.called
  })

  it('should not call DNS if the host is an IPv4 address', () => {
    client = new DogStatsDClient({
      host: '127.0.0.1'
    })

    client.gauge('test.avg', 1)
    client.flush()

    expect(udp4.send).to.have.been.called
    expect(dns.lookup).to.not.have.been.called
  })

  it('should not call DNS if the host is an IPv6 address', () => {
    client = new DogStatsDClient({
      host: '2001:db8:3333:4444:5555:6666:7777:8888'
    })

    client.gauge('test.avg', 1)
    client.flush()

    expect(udp6.send).to.have.been.called
    expect(dns.lookup).to.not.have.been.called
  })

  it('should support configuration', () => {
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
  })

  const udsIt = os.platform() === 'win32' ? it.skip : it
  udsIt('should support HTTP via unix domain socket', (done) => {
    assertData = () => {
      try {
        expect(Buffer.concat(httpData).toString()).to.equal('test.avg:0|g\ntest.avg2:2|g\n')
        done()
      } catch (e) {
        done(e)
      }
    }

    client = new DogStatsDClient({
      metricsProxyUrl: `unix://${udsPath}`
    })

    client.gauge('test.avg', 0)
    client.gauge('test.avg2', 2)
    client.flush()
  })

  it('should support HTTP via port', (done) => {
    assertData = () => {
      try {
        expect(Buffer.concat(httpData).toString()).to.equal('test.avg:1|g\ntest.avg2:2|g\n')
        done()
      } catch (e) {
        done(e)
      }
    }

    client = new DogStatsDClient({
      metricsProxyUrl: `http://localhost:${httpPort}`
    })

    client.gauge('test.avg', 1)
    client.gauge('test.avg2', 2)
    client.flush()
  })

  it('should support HTTP via URL object', (done) => {
    assertData = () => {
      try {
        expect(Buffer.concat(httpData).toString()).to.equal('test.avg:1|g\ntest.avg2:2|g\n')
        done()
      } catch (e) {
        done(e)
      }
    }

    client = new DogStatsDClient({
      metricsProxyUrl: new URL(`http://localhost:${httpPort}`)
    })

    client.gauge('test.avg', 1)
    client.gauge('test.avg2', 2)
    client.flush()
  })

  it('should fail over to UDP', (done) => {
    assertData = () => {
      setTimeout(() => {
        try {
          expect(udp4.send).to.have.been.called
          expect(udp4.send.firstCall.args[0].toString()).to.equal('test.count:10|c\n')
          expect(udp4.send.firstCall.args[2]).to.equal(16)
          done()
        } catch (e) {
          done(e)
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

  describe('CustomMetrics', () => {
    it('.gauge()', () => {
      client = new CustomMetrics({ dogstatsd: {} })

      client.gauge('test.avg', 10, { foo: 'bar' })
      client.flush()

      expect(udp4.send).to.have.been.called
      expect(udp4.send.firstCall.args[0].toString()).to.equal('test.avg:10|g|#foo:bar\n')
    })

    it('.increment()', () => {
      client = new CustomMetrics({ dogstatsd: {} })

      client.increment('test.count', 10)
      client.flush()

      expect(udp4.send).to.have.been.called
      expect(udp4.send.firstCall.args[0].toString()).to.equal('test.count:10|c\n')
    })

    it('.increment() with default', () => {
      client = new CustomMetrics({ dogstatsd: {} })

      client.increment('test.count')
      client.flush()

      expect(udp4.send).to.have.been.called
      expect(udp4.send.firstCall.args[0].toString()).to.equal('test.count:1|c\n')
    })

    it('.decrement()', () => {
      client = new CustomMetrics({ dogstatsd: {} })

      client.decrement('test.count', 10)
      client.flush()

      expect(udp4.send).to.have.been.called
      expect(udp4.send.firstCall.args[0].toString()).to.equal('test.count:-10|c\n')
    })

    it('.decrement() with default', () => {
      client = new CustomMetrics({ dogstatsd: {} })

      client.decrement('test.count')
      client.flush()

      expect(udp4.send).to.have.been.called
      expect(udp4.send.firstCall.args[0].toString()).to.equal('test.count:-1|c\n')
    })

    it('.distribution()', () => {
      client = new CustomMetrics({ dogstatsd: {} })

      client.distribution('test.dist', 10)
      client.flush()

      expect(udp4.send).to.have.been.called
      expect(udp4.send.firstCall.args[0].toString()).to.equal('test.dist:10|d\n')
    })
  })
})
