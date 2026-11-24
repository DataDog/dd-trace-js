'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const log = require('../../../dd-trace/src/log')
const { Distribution } = require('../../src/metrics/model')
const { Processor } = require('../../src/metrics/processor')
const { Timer } = require('../../src/metrics/timer')

const metric = value => new Distribution('my-metric', [
  { timestamp: new Date(1559941498000), value },
], 'tag:a', 'tag:b')
const points = (...values) => [{
  metric: 'my-metric',
  points: values.map(value => [1559941498, [value]]),
  tags: ['tag:a', 'tag:b'],
  type: 'distribution',
}]

describe('Lambda metrics timer and processor source contracts', () => {
  let clock
  beforeEach(() => { clock = sinon.useFakeTimers() })
  afterEach(() => sinon.restore())

  it('resolves each regular timer interval with false', async () => {
    const timer = new Timer(10)
    timer.start()
    const first = timer.nextTimeout()
    assert.strictEqual(timer.nextTimeout(), first)
    await clock.tickAsync(10)
    assert.strictEqual(await first, false)
    const second = timer.nextTimeout()
    assert.notStrictEqual(first, second)
    await clock.tickAsync(10)
    assert.strictEqual(await second, false)
    timer.complete()
  })

  it('immediately completes a pending timeout and subsequent waits', async () => {
    const timer = new Timer(10)
    timer.start()
    const pending = timer.nextTimeout()
    timer.complete()
    assert.strictEqual(await pending, true)
    assert.strictEqual(await timer.nextTimeout(), true)
    timer.complete()
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('does not restart an already started timer', async () => {
    const timer = new Timer(10)
    timer.start()
    const pending = timer.nextTimeout()
    await clock.tickAsync(5)
    timer.start()
    await clock.tickAsync(5)
    assert.strictEqual(await pending, false)
    timer.complete()
  })

  it('completes waits even when never started', async () => {
    const timer = new Timer(10)
    const pending = timer.nextTimeout()
    await clock.tickAsync(20)
    timer.complete()
    assert.strictEqual(await pending, true)
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('batches and sends metrics on a regular interval', async () => {
    const sendMetrics = sinon.stub().resolves()
    const processor = new Processor({ sendMetrics }, 10, true)
    processor.startProcessing()
    processor.startProcessing()
    processor.addMetric(metric(1))
    processor.addMetric(metric(2))
    await clock.tickAsync(10)
    processor.addMetric(metric(3))
    await clock.tickAsync(10)
    await processor.flush()
    assert.deepStrictEqual(sendMetrics.args, [[points(1, 2)], [points(3)]])
    assert.strictEqual(clock.countTimers(), 0)
  })

  for (const start of [true, false]) {
    it(`flushes once and waits for the final send, started=${start}`, async () => {
      let finish
      const sendMetrics = sinon.stub().returns(new Promise(resolve => { finish = resolve }))
      const processor = new Processor({ sendMetrics }, 10, false)
      if (start) processor.startProcessing()
      processor.addMetric(metric(1))
      processor.addMetric(metric(2))
      const done = sinon.spy()
      const first = processor.flush().then(done)
      const second = processor.flush()
      await clock.tickAsync(0)
      sinon.assert.notCalled(done)
      sinon.assert.calledOnceWithExactly(sendMetrics, points(1, 2))
      finish()
      await Promise.all([first, second])
      sinon.assert.calledOnce(done)
      assert.strictEqual(clock.countTimers(), 0)
    })
  }

  it('restores a failed interval batch and adds later metrics for the next interval', async () => {
    const sendMetrics = sinon.stub().onFirstCall().rejects(new Error('failed')).resolves()
    const processor = new Processor({ sendMetrics }, 10, true)
    processor.startProcessing()
    processor.addMetric(metric(1))
    processor.addMetric(metric(2))
    await clock.tickAsync(10)
    processor.addMetric(metric(3))
    await clock.tickAsync(10)
    await processor.flush()
    assert.deepStrictEqual(sendMetrics.args, [[points(1, 2)], [points(1, 2, 3)]])
  })

  for (const retry of [true, false]) {
    it(`preserves source batch-loss behavior during a failed in-flight interval, retry=${retry}`, async () => {
      const warn = sinon.stub(log, 'warn')
      let fail
      const sendMetrics = sinon.stub().onFirstCall().returns(new Promise((resolve, reject) => { fail = reject }))
      sendMetrics.onSecondCall().resolves()
      const processor = new Processor({ sendMetrics }, 10, retry)
      processor.startProcessing()
      processor.addMetric(metric(1))
      await clock.tickAsync(10)
      processor.addMetric(metric(2))
      fail(new Error('failed'))
      await clock.tickAsync(0)
      await processor.flush()
      assert.deepStrictEqual(sendMetrics.args, [[points(1)], [points(retry ? 1 : 2)]])
      assert.strictEqual(warn.callCount, retry ? 1 : 0)
    })
  }

  for (const retry of [true, false]) {
    it(`uses exactly ${retry ? 3 : 1} final attempts at the source retry interval`, async () => {
      const sendMetrics = sinon.stub().rejects(new Error('failure'))
      const processor = new Processor({ sendMetrics }, 10, retry, 10)
      processor.startProcessing()
      processor.addMetric(metric(1))
      const rejected = assert.rejects(processor.flush(), { message: 'Failed to send metrics to Datadog' })
      await clock.tickAsync(0)
      assert.strictEqual(sendMetrics.callCount, 1)
      if (retry) {
        await clock.tickAsync(9)
        assert.strictEqual(sendMetrics.callCount, 1)
        await clock.tickAsync(1)
        assert.strictEqual(sendMetrics.callCount, 2)
        await clock.tickAsync(10)
      }
      await rejected
      assert.strictEqual(sendMetrics.callCount, retry ? 3 : 1)
      assert.strictEqual(clock.countTimers(), 0)
    })
  }

  it('succeeds on a final retry with the same serialized batch', async () => {
    const sendMetrics = sinon.stub().onFirstCall().rejects().resolves()
    const processor = new Processor({ sendMetrics }, 10, true)
    processor.addMetric(metric(1))
    const flush = processor.flush()
    await clock.tickAsync(250)
    await flush
    assert.deepStrictEqual(sendMetrics.args, [[points(1)], [points(1)]])
  })

  it('does not send empty interval or final batches', async () => {
    const sendMetrics = sinon.stub().resolves()
    const processor = new Processor({ sendMetrics }, 10, true)
    processor.startProcessing()
    await clock.tickAsync(30)
    await processor.flush()
    sinon.assert.notCalled(sendMetrics)
    assert.strictEqual(clock.countTimers(), 0)
  })
})
