'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('AgentlessMetricsClient', () => {
  let AgentlessMetricsClient
  let clock
  let log
  let requests

  beforeEach(() => {
    clock = sinon.useFakeTimers({ now: 1_700_000_000_000 })
    log = { error: sinon.stub() }
    requests = []

    AgentlessMetricsClient = proxyquire('../src/agentless-metrics', {
      './exporters/common/request': (body, options, callback) => {
        requests.push({ body: JSON.parse(body), options, callback })
      },
      './log': log,
    })
  })

  afterEach(() => {
    clock.restore()
  })

  function createClient (options = {}) {
    return new AgentlessMetricsClient({
      apiKey: 'test-key',
      reportHostname: false,
      site: 'us3.datadoghq.com',
      tags: ['service:web'],
      ...options,
    })
  }

  it('submits counters and gauges to the direct series endpoint', () => {
    const client = createClient()

    client.increment('requests', 3, ['route:home'])
    client.decrement('queue.size', 2)
    client.gauge('memory', 10)
    client.flush()

    assert.strictEqual(requests.length, 1)
    assert.deepStrictEqual(requests[0], {
      body: {
        series: [
          {
            metric: 'requests',
            points: [[1_700_000_000, 3]],
            tags: ['service:web', 'route:home'],
            type: 'count',
          },
          {
            metric: 'queue.size',
            points: [[1_700_000_000, -2]],
            tags: ['service:web'],
            type: 'count',
          },
          {
            metric: 'memory',
            points: [[1_700_000_000, 10]],
            tags: ['service:web'],
            type: 'gauge',
          },
        ],
      },
      options: {
        method: 'POST',
        url: 'https://api.us3.datadoghq.com',
        path: '/api/v1/series',
        headers: {
          'Content-Type': 'application/json',
          'DD-API-KEY': 'test-key',
        },
      },
      callback: requests[0].callback,
    })
  })

  it('groups distributions by metric and tags', () => {
    const client = createClient()

    client.distribution('latency', 10, ['route:home'])
    client.distribution('latency', 20, ['route:home'])
    client.histogram('latency', 30, ['route:other'])
    client.flush()

    assert.deepStrictEqual(requests[0].body, {
      series: [
        {
          metric: 'latency',
          points: [[1_700_000_000, [10, 20]]],
          tags: ['service:web', 'route:home'],
          type: 'distribution',
        },
        {
          metric: 'latency',
          points: [[1_700_000_000, [30]]],
          tags: ['service:web', 'route:other'],
          type: 'distribution',
        },
      ],
    })
    assert.strictEqual(requests[0].options.path, '/api/v1/distribution_points')
  })

  it('includes the hostname when configured', () => {
    const client = createClient({ reportHostname: true })

    client.gauge('memory', 10)
    client.distribution('latency', 20)
    client.flush()

    assert.strictEqual(requests[0].body.series[0].host, require('node:os').hostname())
    assert.strictEqual(requests[1].body.series[0].host, require('node:os').hostname())
  })

  it('does not make an empty request', () => {
    createClient().flush()

    assert.deepStrictEqual(requests, [])
  })

  it('drops buffered metrics when the API key is missing', () => {
    const client = createClient({ apiKey: undefined })

    client.gauge('memory', 10)
    client.flush()
    client.gauge('memory', 20)
    client.flush()

    assert.deepStrictEqual(requests, [])
    sinon.assert.calledOnceWithExactly(
      log.error,
      'DD_API_KEY is required for agentless metrics. Metrics will not be sent.'
    )
  })

  it('does not send the API key when the site is invalid', () => {
    const client = createClient({ site: 'example.com/path' })

    client.gauge('memory', 10)
    client.flush()

    assert.deepStrictEqual(requests, [])
    sinon.assert.calledOnceWithExactly(
      log.error,
      'Invalid DD_SITE for agentless metrics: %s. Metrics will not be sent.',
      'example.com/path'
    )
  })

  it('logs intake errors', () => {
    const client = createClient()

    client.gauge('memory', 10)
    client.flush()
    requests[0].callback(new Error('unavailable'))

    sinon.assert.calledOnceWithExactly(
      log.error,
      'Failed to send agentless %s: %s',
      'metrics',
      'unavailable'
    )
  })

  it('logs encoding errors instead of throwing', () => {
    const client = createClient()

    Reflect.apply(client.gauge, client, ['memory', 10n])
    client.flush()

    assert.deepStrictEqual(requests, [])
    sinon.assert.calledOnce(log.error)
    assert.deepStrictEqual(log.error.firstCall.args.slice(0, 2), [
      'Failed to encode agentless %s: %s',
      'metrics',
    ])
    assert.match(log.error.firstCall.args[2], /BigInt/)
  })
})

describe('agentless metrics selection', () => {
  it('selects the direct transport without creating DogStatsD sockets', () => {
    const directTransport = {}
    const AgentlessMetricsClient = sinon.stub().returns(directTransport)
    const dgram = { createSocket: sinon.stub().throws(new Error('unexpected UDP socket')) }
    const { createMetricsTransport } = proxyquire('../src/dogstatsd', {
      dgram,
      './agentless-metrics': AgentlessMetricsClient,
    })
    const config = {
      DD_AGENTLESS_ENABLED: true,
      DD_API_KEY: 'test-key',
      dogstatsd: { hostname: 'localhost', port: 8125 },
      lookup: sinon.stub(),
      reportHostname: true,
      runtimeMetricsRuntimeId: false,
      site: 'datadoghq.com',
      tags: { service: 'web' },
    }

    assert.strictEqual(createMetricsTransport(config), directTransport)
    sinon.assert.calledOnceWithExactly(AgentlessMetricsClient, {
      apiKey: 'test-key',
      reportHostname: true,
      site: 'datadoghq.com',
      tags: ['service:web'],
    })
    sinon.assert.notCalled(dgram.createSocket)
  })

  it('preserves runtime process tags on the direct transport', () => {
    const transport = {}
    const aggregatedClient = {}
    const createMetricsTransport = sinon.stub().returns(transport)
    const MetricsAggregationClient = sinon.stub().returns(aggregatedClient)
    const DogStatsDClient = {
      generateClientConfig: sinon.stub().returns({ tags: ['service:web'] }),
    }
    const { createMetricsClient } = proxyquire('../src/runtime_metrics/client', {
      '../dogstatsd': {
        createMetricsTransport,
        DogStatsDClient,
        MetricsAggregationClient,
      },
      '../process-tags': { tagsArray: ['entrypoint.name:server.js'] },
    })
    const config = {
      DD_AGENTLESS_ENABLED: true,
      DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED: true,
    }

    assert.strictEqual(createMetricsClient(config), aggregatedClient)
    sinon.assert.calledOnceWithExactly(createMetricsTransport, config, {
      tags: ['service:web', 'entrypoint.name:server.js'],
    })
    sinon.assert.calledOnceWithExactly(MetricsAggregationClient, transport)
  })
})
