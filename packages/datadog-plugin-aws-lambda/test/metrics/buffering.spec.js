'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')

const { afterEach, describe, it } = require('mocha')
const sinon = require('sinon')

const log = require('../../../dd-trace/src/log')
const { Batcher } = require('../../src/metrics/batcher')
const { isExtensionRunning } = require('../../src/metrics/extension')
const { buildMetricLog, writeMetricToStdout } = require('../../src/metrics/metric-log')
const { Distribution } = require('../../src/metrics/model')
const { MetricsQueue, METRICS_QUEUE_LIMIT } = require('../../src/metrics/queue')

const timestamp = new Date(1559928315000)
const point = value => ({ timestamp, value })
const metric = (value, tags = ['tag:a', 'tag:b', 'tag:c']) => new Distribution('my-dist', [point(value)], ...tags)

describe('Lambda metrics buffering source contracts', () => {
  afterEach(() => sinon.restore())

  it('converts a distribution to API points', () => {
    const distribution = new Distribution('my-dist', [point(1), point(2), point(3)], 'tag:a', 'tag:b', 'tag:c')
    assert.deepStrictEqual(distribution.toAPIMetrics(), [{
      metric: 'my-dist',
      points: [[1559928315, [1]], [1559928315, [2]], [1559928315, [3]]],
      tags: ['tag:a', 'tag:b', 'tag:c'],
      type: 'distribution',
    }])
  })

  it('joins distributions without mutating either input', () => {
    const first = new Distribution('my-dist', [point(1), point(2)], 'tag:a')
    const second = metric(3)
    assert.deepStrictEqual(first.union(second).points, [point(1), point(2), point(3)])
    assert.deepStrictEqual(first.points, [point(1), point(2)])
    assert.deepStrictEqual(second.points, [point(3)])
    assert.strictEqual(first.union({ metricType: 'counter' }), first)
  })

  it('joins different tag orders, retaining first tags and point order', () => {
    const batcher = new Batcher()
    batcher.add(new Distribution('my-dist', [point(1), point(2)], 'tag:a', 'tag:b', 'tag:c'))
    batcher.add(metric(3, ['tag:c', 'tag:b', 'tag:a']))
    assert.deepStrictEqual(batcher.toAPIMetrics(), [{
      metric: 'my-dist',
      points: [[1559928315, [1]], [1559928315, [2]], [1559928315, [3]]],
      tags: ['tag:a', 'tag:b', 'tag:c'],
      type: 'distribution',
    }])
  })

  for (const difference of ['tags', 'name', 'host', 'duplicate tags']) {
    it(`keeps distinct ${difference} in separate batches`, () => {
      const first = metric(1)
      const second = metric(2)
      if (difference === 'tags') second.tags = ['tag:b', 'tag:a']
      if (difference === 'name') second.name = 'other'
      if (difference === 'host') second.host = 'host'
      if (difference === 'duplicate tags') second.tags.push('tag:a')
      const batcher = new Batcher()
      batcher.add(first)
      batcher.add(second)
      assert.deepStrictEqual(batcher.toAPIMetrics(), [...first.toAPIMetrics(), ...second.toAPIMetrics()])
    })
  }

  for (const ms of [1559928315999, 0, -1]) {
    it(`floors API timestamps at ${ms}ms`, () => {
      const distribution = new Distribution('test', [{ timestamp: new Date(ms), value: 0 }])
      assert.deepStrictEqual(distribution.toAPIMetrics()[0].points, [[Math.floor(ms / 1000), [0]]])
    })
  }

  it('enqueues and logs through the tracer logger', () => {
    const debug = sinon.stub(log, 'debug')
    const queue = new MetricsQueue()
    const input = { name: 'metric', tags: [], value: 1 }
    queue.push(input)
    assert.strictEqual(queue.length, 1)
    assert.strictEqual(queue.pop(), input)
    sinon.assert.calledWithExactly(debug,
      'Metrics Listener was not initialized. Enqueuing metric for later processing.')
  })

  it('retains 1024 entries then drops the entire old queue on the next push', () => {
    const warn = sinon.stub(log, 'warn')
    const queue = new MetricsQueue()
    for (let i = 0; i < METRICS_QUEUE_LIMIT; i++) queue.push({ name: 'metric', tags: [], value: i })
    assert.strictEqual(queue.length, 1024)
    sinon.assert.notCalled(warn)
    queue.push({ name: 'metric', tags: [], value: 1024 })
    assert.strictEqual(queue.length, 1)
    assert.strictEqual(queue.pop().value, 1024)
    sinon.assert.calledWithExactly(warn, 'Metrics queue is full, dropping all metrics.')
  })

  it('returns undefined for an empty queue', () => {
    assert.strictEqual(new MetricsQueue().pop(), undefined)
  })

  it('pops the last metric', () => {
    const queue = new MetricsQueue()
    queue.push({ name: 'metric', value: 1, tags: [] })
    queue.push({ name: 'metric', value: 2, tags: [] })
    assert.strictEqual(queue.length, 2)
    assert.deepStrictEqual(queue.pop(), { name: 'metric', value: 2, tags: [] })
  })

  it('reverses the queue before FIFO draining', () => {
    const queue = new MetricsQueue()
    queue.push({ name: 'metric', value: 1, tags: [] })
    queue.push({ name: 'metric', value: 2, tags: [] })
    queue.reverse()
    assert.strictEqual(queue.pop().value, 1)
    assert.strictEqual(queue.pop().value, 2)
  })

  it('resets the queue', () => {
    const queue = new MetricsQueue()
    queue.push({ name: 'metric', value: 1, tags: [] })
    queue.reset()
    assert.strictEqual(queue.length, 0)
    assert.strictEqual(queue.pop(), undefined)
  })

  for (const tags of [[], ['region:us', 'account:dev', 'team:serverless']]) {
    it(`writes exact metric-log JSON with ${tags.length} tags and a final newline`, () => {
      const expected = `{"e":1487076708,"m":"my.test.metric","t":${JSON.stringify(tags)},"v":1337}\n`
      assert.strictEqual(buildMetricLog('my.test.metric', 1337, new Date(1487076708123), tags), expected)
      const write = sinon.stub(process.stdout, 'write')
      writeMetricToStdout('my.test.metric', 1337, new Date(1487076708123), tags)
      sinon.assert.calledOnceWithExactly(write, expected)
    })
  }

  for (const exists of [true, false]) {
    it(`detects extension presence without a network probe: ${exists}`, async () => {
      const access = sinon.stub(fs.promises, 'access')
      if (exists) access.resolves()
      else access.rejects(new Error('missing'))
      assert.strictEqual(await isExtensionRunning(), exists)
      sinon.assert.calledOnceWithExactly(access, '/opt/extensions/datadog-agent', fs.constants.F_OK)
    })
  }

  it('does not expose the retired local-testing flush helper', () => {
    assert.strictEqual(require('../../src/metrics/extension').flushExtension, undefined)
  })
})
