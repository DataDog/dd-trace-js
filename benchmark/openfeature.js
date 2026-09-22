'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire')
const getConfig = require('../packages/dd-trace/src/config')
const { snapshotEvaluationContext } = require('../packages/dd-trace/src/openfeature/writers/flag-evaluation-context')
const { FlagEvaluationAggregator } = require('../packages/dd-trace/src/openfeature/writers/flag-evaluation-aggregation')
const benchmark = require('./benchmark')
const { createSingleExposureEvent, createExposureEventArray } = require('./stubs/exposure-events')
const { evaluationContext } = require('./sirun/openfeature/context')

globalThis[Symbol.for('dd-trace')] ??= { beforeExitHandlers: new Set() }

const ExposuresWriter = proxyquire('../packages/dd-trace/src/openfeature/writers/exposures', {
  '../../exporters/common/request': () => {},
})

const config = getConfig({ service: 'benchmark', version: '1.0.0', env: 'test' })
const suite = benchmark('openfeature')

let writer
let singleEvent
let eventArray

suite
  .add('ExposuresWriter#append (single event)', {
    onStart () {
      writer = new ExposuresWriter(config)
      writer.setEnabled(true)
      singleEvent = createSingleExposureEvent()
    },
    fn () {
      writer.append(singleEvent)
    },
  })
  .add('ExposuresWriter#append (event array)', {
    onStart () {
      writer = new ExposuresWriter(config)
      writer.setEnabled(true)
      eventArray = createExposureEventArray(10)
    },
    fn () {
      writer.append(eventArray)
    },
  })
  .add('ExposuresWriter#append (disabled, single event)', {
    onStart () {
      writer = new ExposuresWriter(config)
      writer.setEnabled(false)
      singleEvent = createSingleExposureEvent()
    },
    fn () {
      writer.append(singleEvent)
    },
  })
  .add('ExposuresWriter#append (disabled, event array)', {
    onStart () {
      writer = new ExposuresWriter(config)
      writer.setEnabled(false)
      eventArray = createExposureEventArray(10)
    },
    fn () {
      writer.append(eventArray)
    },
  })
  .add('ExposuresWriter#makePayload', {
    onStart () {
      writer = new ExposuresWriter(config)
      eventArray = createExposureEventArray(100)
    },
    fn () {
      writer.makePayload(eventArray)
    },
  })

let payloadCount = 0
const BaseWriter = proxyquire('../packages/dd-trace/src/openfeature/writers/base', {
  '../../exporters/common/request': (body, options, callback) => {
    payloadCount++
    callback(null, '', 202)
  },
})
const FlagEvaluationsWriter = proxyquire('../packages/dd-trace/src/openfeature/writers/flag-evaluations', {
  './base': BaseWriter,
})

for (const shape of ['typical', 'scale', 'stress', 'hostile']) {
  let context
  let snapshot
  suite.add(`EVP snapshot (full consent, ${shape})`, {
    onStart () { context = evaluationContext(shape) },
    fn () { snapshot = snapshotEvaluationContext(context) },
    onComplete () {
      assert.ok(Object.isFrozen(snapshot.attrs))
      assert.ok(Object.keys(snapshot.attrs).length > 0)
      assert.ok(Object.keys(snapshot.attrs).length <= 256)
    },
  })
}

for (const consent of [false, true]) {
  const mode = consent ? 'full consent' : 'protected'
  const attrs = snapshotEvaluationContext(evaluationContext('typical')).attrs
  const event = {
    flagKey: 'checkout',
    variant: 'on',
    runtimeDefault: false,
    targetingKey: 'benchmark-customer',
    attrs,
    observeFullEvaluationData: consent,
    timestamp: 1_759_276_800_000,
  }
  let aggregator
  let accepted
  let count
  let queueWriter
  suite.add(`EVP aggregation (256 existing-bucket observations, ${mode})`, {
    onStart () { aggregator = new FlagEvaluationAggregator() },
    fn () {
      for (let i = 0; i < 256; i++) aggregator.add(event)
      count = aggregator.take().full.values().next().value.count
    },
    onComplete () { assert.strictEqual(count, 256) },
  })
  for (const flush of [false, true]) {
    let calls
    suite.add(`EVP enqueue+${flush ? 'drain+serialize' : 'discard'} (256 accepted, ${mode})`, {
      onStart () {
        calls = 0
        payloadCount = 0
        queueWriter = new FlagEvaluationsWriter(config)
        queueWriter.setEnabled(true)
      },
      fn () {
        calls++
        accepted = 0
        for (let i = 0; i < 256; i++) accepted += Number(queueWriter.enqueue(event))
        if (flush) {
          queueWriter.flush()
        } else {
          queueWriter.setEnabled(false)
          queueWriter.setEnabled(true)
        }
      },
      onComplete () {
        assert.strictEqual(accepted, 256)
        assert.strictEqual(payloadCount, flush ? calls : 0)
        queueWriter.destroy()
      },
    })
  }
  suite.add(`EVP queue-full rejection (${mode})`, {
    onStart () {
      queueWriter = new FlagEvaluationsWriter(config)
      queueWriter.setEnabled(true)
      for (let i = 0; i < 4096; i++) assert.strictEqual(queueWriter.enqueue(event), true)
    },
    fn () { accepted = queueWriter.enqueue(event) },
    onComplete () {
      assert.strictEqual(accepted, false)
      queueWriter.setEnabled(false)
      queueWriter.destroy()
    },
  })
}

suite.run()
