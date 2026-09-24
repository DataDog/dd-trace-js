'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')
const {
  createWorkerState, collectWorkerTelemetry,
} = require('../../../src/openfeature/writers/flag-evaluation-telemetry')
const telemetryMetrics = require('../../../src/telemetry/metrics')

const writers = '../../../src/openfeature/writers/'
const ddTrace = Symbol.for('dd-trace')

describe('flag evaluation worker entry point', () => {
  let clock
  let descriptor
  let port
  let requests
  let state

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    requests = []
    descriptor = Object.getOwnPropertyDescriptor(globalThis, ddTrace)
    Object.defineProperty(globalThis, ddTrace, { ...descriptor, writable: true })
    port = Object.assign(new EventEmitter(), { close: sinon.spy(), postMessage: sinon.spy() })
    state = createWorkerState()
    // Keep the real consumer and accounting; give the simulated isolate its own telemetry module.
    const telemetry = proxyquire(writers + 'flag-evaluation-telemetry', {})
    const Base = proxyquire(writers + 'base', {
      '../../exporters/common/request': (payload, options, callback) => {
        requests.push({ payload, options, callback })
      },
    })
    const Consumer = proxyquire(writers + 'flag-evaluation-consumer', {
      './base': Base,
      './flag-evaluation-telemetry': telemetry,
      './flag-evaluation-aggregation': proxyquire(writers + 'flag-evaluation-aggregation', {
        './flag-evaluation-telemetry': telemetry,
      }),
      './flag-evaluation-payload': proxyquire(writers + 'flag-evaluation-payload', {
        './flag-evaluation-telemetry': telemetry,
      }),
    })
    Consumer['@noCallThru'] = true
    proxyquire(writers + 'flag-evaluation-worker', {
      'node:worker_threads': {
        parentPort: port,
        workerData: {
          route: { url: 'http://localhost:8126/', basePath: '', id: 1, onUnavailable: true },
          context: { service: 'test' },
          state: state.buffer,
        },
      },
      './flag-evaluation-telemetry': telemetry,
      './flag-evaluation-consumer': Consumer,
    })
  })

  afterEach(() => {
    port.emit('message', { type: 'close' })
    Object.defineProperty(globalThis, ddTrace, descriptor)
    clock.restore()
    telemetryMetrics.manager.namespace('general').reset()
  })

  function post () {
    Atomics.add(state, 0, 2)
    Atomics.add(state, 1, 2)
    port.emit('message', {
      type: 'batch',
      events: [{ flagKey: 'flag', timestamp: 100 }, { flagKey: 'flag', timestamp: 100 }],
    })
  }

  it('closes promptly after the last in-flight payload, not before delivery completes', () => {
    post()
    clock.tick(0)
    assert.deepStrictEqual([Atomics.load(state, 0), Atomics.load(state, 1)], [0, 2])
    port.emit('message', { type: 'close' })
    assert.strictEqual(requests.length, 1)
    assert.strictEqual(JSON.parse(requests[0].payload).flagEvaluations[0].evaluation_count, 2)
    sinon.assert.notCalled(port.close)
    requests[0].callback(null, '', 202)
    sinon.assert.calledOnce(port.close)
    assert.deepStrictEqual([Atomics.load(state, 0), Atomics.load(state, 1)], [0, 0])
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('closes an idle worker immediately without a delivery or deadline', () => {
    port.emit('message', { type: 'close' })
    sinon.assert.calledOnce(port.close)
    assert.strictEqual(requests.length, 0)
    assert.strictEqual(clock.countTimers(), 0)
  })

  for (const fallback of [false, true]) {
    for (const [result, replay, switchRoute] of [
      [202, false, false], [400, false, false], [404, true, true], [405, true, true],
      [403, false, true], [429, false, true], [500, false, true], [599, false, true],
      ['ECONNREFUSED', true, true], ['ENOTFOUND', true, true], ['EAI_AGAIN', true, true], ['ENOENT', true, true],
      ['ECONNRESET', false, true], ['ETIMEDOUT', false, true], ['ERR_DD_REQUEST_BUFFER_FULL', false, false],
    ]) {
      it(`settles ownership once after ${result}, fallback=${fallback}, without ambiguous replay`, () => {
        port.emit('message', {
          type: 'enabled',
          enabled: true,
          route: {
            id: 2,
            url: 'http://localhost:8126/',
            basePath: '',
            onFallback: fallback,
            onUnavailable: !fallback,
            fallback: fallback ? { url: 'http://localhost:8127/', basePath: '' } : undefined,
          },
        })
        post()
        port.emit('message', { type: 'flush' })
        const error = typeof result === 'string' ? Object.assign(new Error(result), { code: result }) : null
        requests[0].callback(error, '', typeof result === 'number' ? result : undefined)
        assert.strictEqual(requests.length, fallback && replay ? 2 : 1)
        if (fallback && replay) {
          assert.strictEqual(Atomics.load(state, 1), 2)
          requests[1].callback(null, '', 202)
        }
        assert.deepStrictEqual([Atomics.load(state, 0), Atomics.load(state, 1)], [0, 0])
        if (switchRoute) {
          sinon.assert.calledOnceWithExactly(port.postMessage, {
            type: 'route', id: 2, status: fallback ? 'fallback' : 'unavailable',
          })
        } else {
          sinon.assert.notCalled(port.postMessage)
        }
        port.emit('message', { type: 'close' })
        sinon.assert.calledOnce(port.close)
      })
    }
  }

  it('relays unavailability on the initial route and accepts a recovered route', () => {
    post()
    port.emit('message', { type: 'flush' })
    requests[0].callback(null, '', 404)
    sinon.assert.calledOnceWithExactly(port.postMessage, { type: 'route', id: 1, status: 'unavailable' })
    port.emit('message', { type: 'enabled', enabled: false })
    port.emit('message', {
      type: 'enabled',
      enabled: true,
      route: { id: 3, url: 'http://localhost:8128/', basePath: '/recovered', onUnavailable: true },
    })
    post()
    port.emit('message', { type: 'flush' })
    assert.strictEqual(requests[1].options.url.href, 'http://localhost:8128/')
    assert.strictEqual(requests[1].options.path, '/recovered/api/v2/flagevaluation')
    requests[1].callback(null, '', 202)
    assert.strictEqual(Atomics.load(state, 1), 0)
  })

  it('releases both credits and counts a rejected batch exactly once', () => {
    port.emit('message', { type: 'enabled', enabled: false })
    post()
    assert.deepStrictEqual([Atomics.load(state, 0), Atomics.load(state, 1)], [0, 0])
    collectWorkerTelemetry(state)
    const series = telemetryMetrics.manager.namespace('general').toJSON().metrics.series
    const drops = series.filter(metric => metric.metric === 'flagevaluation.rows.dropped')
    assert.strictEqual(drops.length, 1)
    assert.deepStrictEqual(drops[0].tags, ['reason:unavailable'])
    assert.strictEqual(drops[0].points[0][1], 2)
    assert.strictEqual(requests.length, 0)
  })
})
