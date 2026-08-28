'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const os = require('node:os')
const { performance } = require('node:perf_hooks')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const datadogCore = require('../../datadog-core')

require('./setup/core')
const TelemetryDeliveryTracker = require('../src/serverless/telemetry-delivery-tracker')

describe('dogstatsd', () => {
  let client
  let DogStatsDClient
  let CustomMetrics
  let MetricsAggregationClient
  let createMetricsAggregationClient
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
  let registerTelemetryFlusher
  let createServerlessDeliveryTracker

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
    registerTelemetryFlusher = sinon.stub()
    createServerlessDeliveryTracker = sinon.stub()

    const dogstatsd = proxyquire.noPreserveCache().noCallThru()('../src/dogstatsd', {
      dgram,
      '../../datadog-core': datadogCore,
      './flush': { registerTelemetryFlusher },
      './serverless': { createServerlessDeliveryTracker },
      './exporters/common/docker': docker,
      './log': log,
    })
    DogStatsDClient = dogstatsd.DogStatsDClient
    CustomMetrics = dogstatsd.CustomMetrics
    MetricsAggregationClient = dogstatsd.MetricsAggregationClient
    createMetricsAggregationClient = dogstatsd.createMetricsAggregationClient

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

  /**
   * @param {object} [options] - DogStatsD client overrides
   * @returns {MetricsAggregationClient} Client with self-telemetry enabled
   */
  function createTelemetryClient (options) {
    return createMetricsAggregationClient({
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

  /**
   * @param {Error} [error] - Asynchronous send result
   * @returns {Promise<void>[]} Send completions
   */
  function stubUdpSend (error) {
    const completions = []

    udp4.send = sinon.stub().callsFake((buffer, offset, length, port, address, callback) => {
      completions.push(Promise.resolve().then(() => callback?.(error)))
    })
    udp6.send = sinon.stub().callsFake((buffer, offset, length, port, address, callback) => {
      completions.push(Promise.resolve().then(() => callback?.(error)))
    })

    return completions
  }

  /**
   * @param {number} start - First UDP call to include
   * @param {number} [end] - First UDP call to exclude
   * @returns {string} Concatenated UDP payload
   */
  function getUdpPayload (start, end = udp4.send.callCount) {
    let payload = ''

    for (let index = start; index < end; index++) {
      payload += udp4.send.getCall(index).args[0].toString()
    }

    return payload
  }

  describe('client telemetry', () => {
    it('emits the client and aggregation metrics every 10 seconds with common UDP tags', async () => {
      const now = sinon.stub(performance, 'now').returns(0)
      const completions = stubUdpSend()

      try {
        client = createTelemetryClient()

        client.increment('test.count')
        client.increment('test.count')
        client.count('test.delta', 1, [], false)
        client.gauge('test.gauge', 5)
        client.gauge('test.gauge', 6)
        client.distribution('test.distribution', 3)
        client.histogram('test.histogram', 7)
        client.histogram('test.histogram', 8)
        client.flush()

        const userPacketCount = udp4.send.callCount
        let userBytes = 0
        for (let index = 0; index < userPacketCount; index++) {
          userBytes += udp4.send.getCall(index).args[0].length
        }
        await Promise.all(completions)

        now.returns(9_999)
        client.flush()

        sinon.assert.callCount(udp4.send, userPacketCount)

        now.returns(10_000)
        client.flush()

        const firstTelemetryEnd = udp4.send.callCount
        const telemetry = getUdpPayload(userPacketCount)

        assert.match(telemetry, /client:nodejs/)
        assert.match(telemetry, /client_version:\d+\.\d+\.\d+/)
        assert.match(telemetry, /client_transport:udp/)
        assert.match(telemetry, /datadog\.dogstatsd\.client\.metrics:8\|c\|/)
        assert.match(telemetry, /datadog\.dogstatsd\.client\.metrics_by_type:2\|c\|.*metrics_type:count/)
        assert.match(telemetry, /datadog\.dogstatsd\.client\.metrics_by_type:3\|c\|.*metrics_type:gauge/)
        assert.match(telemetry, /datadog\.dogstatsd\.client\.metrics_by_type:1\|c\|.*metrics_type:distribution/)
        assert.match(telemetry, /datadog\.dogstatsd\.client\.metrics_by_type:2\|c\|.*metrics_type:histogram/)
        assert.match(telemetry, /datadog\.dogstatsd\.client\.aggregated_context:4\|c\|/)
        assert.match(
          telemetry,
          /datadog\.dogstatsd\.client\.aggregated_context_by_type:1\|c\|.*metrics_type:count/
        )
        assert.match(
          telemetry,
          /datadog\.dogstatsd\.client\.aggregated_context_by_type:2\|c\|.*metrics_type:gauge/
        )
        assert.match(
          telemetry,
          /datadog\.dogstatsd\.client\.aggregated_context_by_type:0\|c\|.*metrics_type:distribution/
        )
        assert.match(
          telemetry,
          /datadog\.dogstatsd\.client\.aggregated_context_by_type:1\|c\|.*metrics_type:histogram/
        )
        assert.match(telemetry, new RegExp(`datadog\\.dogstatsd\\.client\\.bytes_sent:${userBytes}\\|c\\|`))
        assert.match(telemetry, new RegExp(`datadog\\.dogstatsd\\.client\\.packets_sent:${userPacketCount}\\|c\\|`))

        client.flush()
        sinon.assert.callCount(udp4.send, firstTelemetryEnd)

        now.returns(20_000)
        client.flush()

        const secondTelemetry = getUdpPayload(firstTelemetryEnd)
        assert.match(secondTelemetry, /datadog\.dogstatsd\.client\.metrics:0\|c\|/)
        assert.match(secondTelemetry, /datadog\.dogstatsd\.client\.aggregated_context:0\|c\|/)
        assert.match(secondTelemetry, /datadog\.dogstatsd\.client\.bytes_sent:0\|c\|/)
        assert.match(secondTelemetry, /datadog\.dogstatsd\.client\.packets_sent:0\|c\|/)
      } finally {
        now.restore()
      }
    })

    it('keeps metrics isolated between telemetry clients', async () => {
      const now = sinon.stub(performance, 'now').returns(0)
      const completions = stubUdpSend()

      try {
        const firstClient = createTelemetryClient({ tags: ['client:first'] })
        const secondClient = createTelemetryClient({ tags: ['client:second'] })

        firstClient.gauge('first.metric', 1)
        firstClient.flush()
        secondClient.gauge('second.metric', 1)
        secondClient.gauge('second.metric', 2)
        secondClient.flush()

        const userPacketCount = udp4.send.callCount
        await Promise.all(completions)

        now.returns(10_000)
        firstClient.flush()
        const firstTelemetryEnd = udp4.send.callCount
        secondClient.flush()

        const firstTelemetry = getUdpPayload(userPacketCount, firstTelemetryEnd)
        const secondTelemetry = getUdpPayload(firstTelemetryEnd)

        assert.doesNotMatch(firstTelemetry, /datadog\.dogstatsd\.client\.metrics:2\|c\|/)
        assert.match(firstTelemetry, /datadog\.dogstatsd\.client\.metrics:1\|c\|/)
        assert.match(firstTelemetry, /client:first/)
        assert.doesNotMatch(firstTelemetry, /client:second/)
        assert.doesNotMatch(secondTelemetry, /datadog\.dogstatsd\.client\.metrics:1\|c\|/)
        assert.match(secondTelemetry, /datadog\.dogstatsd\.client\.metrics:2\|c\|/)
        assert.match(secondTelemetry, /client:second/)
        assert.doesNotMatch(secondTelemetry, /client:first/)

        await Promise.all(completions.slice(userPacketCount))
      } finally {
        now.restore()
      }
    })

    it('keeps the raw transport path callback-free', () => {
      const now = sinon.stub(performance, 'now').returns(0)

      try {
        client = new MetricsAggregationClient(new DogStatsDClient({
          host: '127.0.0.1',
          lookup: dns.lookup,
          port: 8125,
          tags: [],
        }))
        client.increment('test.count')
        client.flush()

        sinon.assert.calledOnce(udp4.send)
        assert.strictEqual(udp4.send.firstCall.args.length, 5)

        now.returns(10_000)
        client.flush()

        sinon.assert.calledOnce(udp4.send)
      } finally {
        now.restore()
      }
    })

    it('records asynchronous UDP completions in the next telemetry interval', () => {
      const now = sinon.stub(performance, 'now').returns(0)
      const callbacks = []
      udp4.send = sinon.stub().callsFake((buffer, offset, length, port, address, callback) => {
        if (callback) callbacks.push(callback)
      })

      try {
        client = createTelemetryClient()
        client.increment('test.count')
        client.flush()

        const userPacketCount = udp4.send.callCount

        now.returns(10_000)
        client.flush()

        const firstTelemetryEnd = udp4.send.callCount
        const firstTelemetry = getUdpPayload(userPacketCount)
        assert.match(firstTelemetry, /datadog\.dogstatsd\.client\.bytes_sent:0\|c\|/)
        assert.match(firstTelemetry, /datadog\.dogstatsd\.client\.packets_sent:0\|c\|/)

        callbacks[0]()
        now.returns(20_000)
        client.flush()

        const secondTelemetry = getUdpPayload(firstTelemetryEnd)
        assert.match(secondTelemetry, /datadog\.dogstatsd\.client\.bytes_sent:15\|c\|/)
        assert.match(secondTelemetry, /datadog\.dogstatsd\.client\.packets_sent:1\|c\|/)
      } finally {
        now.restore()
      }
    })

    it('reports asynchronous UDP send failures', async () => {
      const now = sinon.stub(performance, 'now').returns(0)
      const completions = stubUdpSend(new Error('send failed'))

      try {
        client = createTelemetryClient()
        client.gauge('test.avg', 1)
        client.flush()

        await Promise.all(completions)

        const userPacketCount = udp4.send.callCount
        now.returns(10_000)
        client.flush()

        const telemetry = getUdpPayload(userPacketCount)
        assert.match(telemetry, /datadog\.dogstatsd\.client\.bytes_dropped:13\|c\|/)
        assert.match(telemetry, /datadog\.dogstatsd\.client\.packets_dropped:1\|c\|/)
      } finally {
        now.restore()
      }
    })

    it('reports DNS drops without exposing transport state', () => {
      const now = sinon.stub(performance, 'now').returns(0)
      const lookup = sinon.stub()
      lookup.onFirstCall().callsArgWith(1, new Error('lookup failed'))
      lookup.onSecondCall().callsArgWith(1, undefined, '127.0.0.1', 4)

      try {
        client = createTelemetryClient({ host: 'invalid', lookup })
        client.gauge('test.avg', 1)
        client.flush()

        sinon.assert.notCalled(udp4.send)

        now.returns(10_000)
        client.flush()

        const telemetry = getUdpPayload(0)
        assert.match(telemetry, /datadog\.dogstatsd\.client\.bytes_dropped:13\|c\|/)
        assert.match(telemetry, /datadog\.dogstatsd\.client\.packets_dropped:1\|c\|/)
      } finally {
        now.restore()
      }
    })

    it('drops failed telemetry after DNS recovers', async () => {
      const now = sinon.stub(performance, 'now').returns(0)
      const completions = stubUdpSend()
      const lookup = sinon.stub()
      lookup.onFirstCall().callsArgWith(1, undefined, '127.0.0.1', 4)
      lookup.onSecondCall().callsArgWith(1, new Error('lookup failed'))
      lookup.onThirdCall().callsArgWith(1, new Error('lookup failed'))
      lookup.onCall(3).callsArgWith(1, new Error('lookup failed'))
      lookup.onCall(4).callsArgWith(1, undefined, '127.0.0.1', 4)

      try {
        client = createTelemetryClient({ host: 'dogstatsd.test', lookup })
        client.gauge('test.avg', 1)
        client.flush()
        await Promise.all(completions)

        const userPacketCount = udp4.send.callCount
        now.returns(10_000)
        client.flush()
        sinon.assert.callCount(udp4.send, userPacketCount)

        now.returns(20_000)
        client.flush()
        sinon.assert.callCount(udp4.send, userPacketCount)

        now.returns(30_000)
        client.flush()
        sinon.assert.callCount(udp4.send, userPacketCount)

        now.returns(40_000)
        client.flush()
        await Promise.all(completions.slice(userPacketCount))

        const telemetry = getUdpPayload(userPacketCount)
        assert.match(telemetry, /datadog\.dogstatsd\.client\.metrics:0\|c\|/)
        assert.doesNotMatch(telemetry, /datadog\.dogstatsd\.client\.metrics:1\|c\|/)
        assert.strictEqual(telemetry.match(/datadog\.dogstatsd\.client\.metrics:/g)?.length, 1)
      } finally {
        now.restore()
      }
    })

    it('drops failed telemetry datagrams', async () => {
      const now = sinon.stub(performance, 'now').returns(0)
      const completions = []
      let failedBuffer

      udp4.send = sinon.stub().callsFake((buffer, offset, length, port, address, callback) => {
        let error
        if (failedBuffer === undefined && buffer.includes('datadog.dogstatsd.client.')) {
          failedBuffer = buffer
          error = new Error('send failed')
        }
        completions.push(Promise.resolve().then(() => callback?.(error)))
      })

      try {
        client = createTelemetryClient()
        client.gauge('test.avg', 1)
        client.flush()
        await Promise.all(completions)

        const userPacketCount = udp4.send.callCount
        now.returns(10_000)
        client.flush()
        await Promise.all(completions.slice(userPacketCount))

        const firstTelemetryEnd = udp4.send.callCount
        assert.ok(failedBuffer)

        now.returns(20_000)
        client.flush()
        await Promise.all(completions.slice(firstTelemetryEnd))

        for (let index = firstTelemetryEnd; index < udp4.send.callCount; index++) {
          assert.notStrictEqual(udp4.send.getCall(index).args[0], failedBuffer)
        }
        const telemetry = getUdpPayload(firstTelemetryEnd)
        assert.match(telemetry, /datadog\.dogstatsd\.client\.metrics:0\|c\|/)
        assert.doesNotMatch(telemetry, /datadog\.dogstatsd\.client\.metrics:1\|c\|/)
      } finally {
        now.restore()
      }
    })

    it('drops saturated HTTP writes without falling back to UDP or retrying telemetry', () => {
      const now = sinon.stub(performance, 'now').returns(0)
      const sendRequest = sinon.stub()
      const capacityError = new Error('request buffer is full')
      capacityError.code = 'ERR_DD_REQUEST_BUFFER_FULL'
      sendRequest.onFirstCall().callsArgWith(2, capacityError, undefined, undefined, undefined, true)
      sendRequest.onSecondCall().callsArgWith(2, capacityError, undefined, undefined, undefined, true)
      sendRequest.onThirdCall().callsArgWith(2, null, '', 200, {})
      const dogstatsd = proxyquire.noPreserveCache().noCallThru()('../src/dogstatsd', {
        dgram,
        '../../datadog-core': datadogCore,
        './exporters/common/docker': docker,
        './exporters/common/request': sendRequest,
        './log': log,
      })

      try {
        const done = sinon.spy()
        client = dogstatsd.createMetricsAggregationClient({
          host: '127.0.0.1',
          lookup: dns.lookup,
          metricsProxyUrl: `http://localhost:${httpPort}`,
          port: 8125,
          tags: [],
        })
        client.gauge('test.avg', 1)
        client.flush(done)

        sinon.assert.calledOnce(done)
        sinon.assert.notCalled(udp4.send)

        now.returns(10_000)
        client.flush()

        const telemetry = sendRequest.secondCall.args[0].toString()
        assert.match(telemetry, /datadog\.dogstatsd\.client\.bytes_dropped:13\|c\|/)
        assert.match(telemetry, /datadog\.dogstatsd\.client\.packets_dropped:1\|c\|/)

        now.returns(20_000)
        client.flush()

        const nextTelemetry = sendRequest.thirdCall.args[0].toString()
        assert.match(nextTelemetry, /datadog\.dogstatsd\.client\.bytes_dropped:0\|c\|/)
        assert.match(nextTelemetry, /datadog\.dogstatsd\.client\.packets_dropped:0\|c\|/)
        assert.doesNotMatch(nextTelemetry, /datadog\.dogstatsd\.client\.bytes_dropped:13\|c\|/)
        sinon.assert.notCalled(udp4.send)
      } finally {
        now.restore()
      }
    })

    it('uses HTTP transport tags and a separate telemetry payload', async () => {
      const now = sinon.stub(performance, 'now').returns(0)
      const payloads = []
      const telemetryReceived = new Promise(resolve => {
        assertData = () => {
          payloads.push(Buffer.concat(httpData).toString())
          httpData.length = 0

          if (payloads.length === 1) {
            now.returns(10_000)
            client.flush()
            return
          }

          resolve()
        }
      })

      try {
        client = createTelemetryClient({ metricsProxyUrl: `http://localhost:${httpPort}` })
        client.gauge('test.avg', 1)
        client.flush()

        await telemetryReceived

        assert.strictEqual(payloads[0], 'test.avg:1|g\n')
        assert.match(payloads[1], /datadog\.dogstatsd\.client\.metrics:1\|c\|/)
        assert.match(payloads[1], /client_transport:http/)
      } finally {
        now.restore()
      }
    })

    it('switches the telemetry transport tag after a 404 permanently disables HTTP', async () => {
      const now = sinon.stub(performance, 'now').returns(0)
      const udpSent = new Promise(resolve => {
        udp4.send = sinon.stub().callsFake((buffer, offset, length, port, address, callback) => {
          callback?.()
          resolve()
        })
      })
      statusCode = 404

      try {
        client = createTelemetryClient({ metricsProxyUrl: `http://localhost:${httpPort}` })
        client.gauge('test.avg', 1)
        client.flush()

        await udpSent

        const userPacketCount = udp4.send.callCount
        now.returns(10_000)
        client.flush()

        const telemetry = getUdpPayload(userPacketCount)
        assert.match(telemetry, /client_transport:udp/)
        assert.match(telemetry, /datadog\.dogstatsd\.client\.bytes_sent:13\|c\|/)
      } finally {
        now.restore()
      }
    })

    it('keeps the HTTP transport tag after a transient UDP fallback', async () => {
      const now = sinon.stub(performance, 'now').returns(0)
      let resolveUdp
      const udpSent = new Promise(resolve => {
        resolveUdp = resolve
      })
      const httpAttempted = new Promise(resolve => {
        assertData = resolve
      })
      udp4.send = sinon.stub().callsFake((buffer, offset, length, port, address, callback) => {
        callback?.()
        resolveUdp()
      })
      statusCode = 500

      try {
        client = createTelemetryClient({ metricsProxyUrl: `http://localhost:${httpPort}` })
        client.gauge('test.avg', 1)
        client.flush()

        await Promise.all([httpAttempted, udpSent])
        httpData.length = 0

        const telemetryReceived = new Promise(resolve => {
          assertData = resolve
        })
        now.returns(10_000)
        client.flush()

        await telemetryReceived

        const telemetry = Buffer.concat(httpData).toString()
        assert.match(telemetry, /client_transport:http/)
        assert.match(telemetry, /datadog\.dogstatsd\.client\.bytes_sent:13\|c\|/)
      } finally {
        now.restore()
      }
    })
  })

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

  it('calls the flush callback after UDP accepts the metrics', (done) => {
    udp4.send = sinon.stub().callsFake((...args) => args.at(-1)())
    client = createDogStatsDClient()

    client.gauge('test.avg', 1)
    client.flush(() => {
      sinon.assert.calledOnce(udp4.send)
      done()
    })
  })

  it('joins an already in-flight UDP flush', (done) => {
    let completeFirstFlush
    udp4.send = sinon.stub().callsFake((...args) => {
      completeFirstFlush = args.at(-1)
    })
    createServerlessDeliveryTracker.returns(new TelemetryDeliveryTracker())
    client = createDogStatsDClient()
    client.gauge('test.avg', 1)
    client.flush()

    client.flush(() => {
      try {
        sinon.assert.calledOnce(udp4.send)
        done()
      } catch (error) {
        done(error)
      }
    })

    assert.strictEqual(completeFirstFlush instanceof Function, true)
    completeFirstFlush()
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

  it('runs the UDP send inside the noop store so its own dns.lookup is not traced', () => {
    const legacyStorage = datadogCore.storage('legacy')
    const noopBeforeSend = legacyStorage.getHandle()?.noop
    let noopDuringSend

    udp4.send = sinon.stub().callsFake(() => {
      noopDuringSend = legacyStorage.getHandle()?.noop
    })

    client = createDogStatsDClient({ host: '127.0.0.1' })

    client.gauge('test.avg', 1)
    client.flush()

    sinon.assert.called(udp4.send)
    assert.strictEqual(noopDuringSend, true)
    assert.strictEqual(legacyStorage.getHandle()?.noop, noopBeforeSend)
  })

  it('runs the UDP send inside the noop store after a DNS lookup resolves the host', () => {
    const legacyStorage = datadogCore.storage('legacy')
    let noopDuringSend

    udp4.send = sinon.stub().callsFake(() => {
      noopDuringSend = legacyStorage.getHandle()?.noop
    })

    client = createDogStatsDClient({ host: 'localhost' })

    client.gauge('test.avg', 1)
    client.flush()

    sinon.assert.called(dns.lookup)
    sinon.assert.called(udp4.send)
    assert.strictEqual(noopDuringSend, true)
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

  it('calls the flush callback after the HTTP proxy responds', (done) => {
    client = createDogStatsDClient({
      metricsProxyUrl: `http://localhost:${httpPort}`,
    })

    client.gauge('test.avg', 1)
    client.flush(() => {
      try {
        assert.strictEqual(Buffer.concat(httpData).toString(), 'test.avg:1|g\n')
        done()
      } catch (error) {
        done(error)
      }
    })
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

    const request = sinon.stub().callsFake((buffer, options, callback) => {
      callback(new Error('connection refused'))
    })
    const { DogStatsDClient: FailingDogStatsDClient } = proxyquire.noPreserveCache().noCallThru()('../src/dogstatsd', {
      dgram,
      '../../datadog-core': datadogCore,
      './exporters/common/docker': docker,
      './exporters/common/request': request,
      './log': log,
    })

    client = new FailingDogStatsDClient({
      host: 'localhost',
      lookup: dns.lookup,
      metricsProxyUrl: 'http://localhost:8126',
      port: 8125,
      tags: [],
    })

    client.increment('test.foo', 10)

    client.flush()
  })

  describe('CustomMetrics', () => {
    it('registers its aggregated metrics flush with the telemetry lifecycle', () => {
      udp4.send = sinon.stub().callsFake((_buffer, _offset, _length, _port, _host, done) => done())
      client = createCustomMetrics()
      client.gauge('test.avg', 10)
      const done = sinon.spy()

      registerTelemetryFlusher.firstCall.args[0](done)

      sinon.assert.calledOnce(done)
      sinon.assert.calledOnce(udp4.send)
    })

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

      assert(
        gaugeCalls.length > 0 && incrementCalls.length > 0,
        `Got gauge=${gaugeCalls.length}, increment=${incrementCalls.length}`
      )

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
