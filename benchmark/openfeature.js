'use strict'

// The FFE writers register a beforeExit handler on the shared dd-trace global, which the
// tracer entry point normally creates. Initialize it here so the writers can be exercised
// standalone in this benchmark without loading the full tracer.
const ddTraceSymbol = Symbol.for('dd-trace')
if (!globalThis[ddTraceSymbol]?.beforeExitHandlers) {
  globalThis[ddTraceSymbol] = { ...globalThis[ddTraceSymbol], beforeExitHandlers: new Set() }
}

const proxyquire = require('proxyquire')
const getConfig = require('../packages/dd-trace/src/config')
const FlagEvalEVPHook = require('../packages/dd-trace/src/openfeature/writers/flag_eval_evp_hook')
const benchmark = require('./benchmark')
const {
  createSingleExposureEvent,
  createExposureEventArray,
  createFlagEvalEVPHookArgs,
} = require('./stubs/exposure-events')

const ExposuresWriter = proxyquire('../packages/dd-trace/src/openfeature/writers/exposures', {
  '../../exporters/common/request': () => {},
})

const FlagEvaluationsWriter = proxyquire('../packages/dd-trace/src/openfeature/writers/flag_evaluations', {
  './base': proxyquire('../packages/dd-trace/src/openfeature/writers/base', {
    '../../exporters/common/request': () => {},
  }),
})

const config = getConfig({ service: 'benchmark', version: '1.0.0', env: 'test' })
const suite = benchmark('openfeature')

let writer
let singleEvent
let eventArray
let flagEvalWriter
let flagEvalEVPHook
let flagEvalArgs

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
  // EVP flagevaluation hot path: the cost a flag evaluation pays for the Finally hook.
  // This is the synchronous work charged to the caller's evaluation — it must stay cheap
  // (scalar capture + bounded enqueue), with all aggregation deferred to the drain below.
  .add('FlagEvalEVPHook#finally (eval hot path)', {
    onStart () {
      flagEvalWriter = new FlagEvaluationsWriter(config)
      flagEvalEVPHook = new FlagEvalEVPHook(flagEvalWriter)
      flagEvalArgs = createFlagEvalEVPHookArgs()
    },
    fn () {
      // Keep the bounded queue from filling so we measure the steady-state enqueue cost,
      // not the overflow drop path.
      if (flagEvalWriter._rawQueue.length >= flagEvalWriter._rawQueueCap) {
        flagEvalWriter._rawQueue.length = 0
      }
      flagEvalEVPHook.finally(flagEvalArgs.hookContext, flagEvalArgs.evaluationDetails)
    },
  })
  // Off-hot-path aggregator cost: the canonical-key + two-tier map work that runs in
  // the deferred drain, NOT on the evaluation path. Measured for completeness.
  .add('FlagEvaluationsWriter#_aggregate (deferred worker path)', {
    onStart () {
      flagEvalWriter = new FlagEvaluationsWriter(config)
      flagEvalArgs = createFlagEvalEVPHookArgs()
    },
    fn () {
      flagEvalWriter._aggregate({
        flagKey: flagEvalArgs.hookContext.flagKey,
        variant: flagEvalArgs.evaluationDetails.variant,
        allocationKey: 'allocation-123',
        targetingKey: flagEvalArgs.hookContext.context.targetingKey,
        evalTimeMs: 1760000000000,
        attrs: {
          plan: flagEvalArgs.hookContext.context.plan,
          country: flagEvalArgs.hookContext.context.country,
          betaTester: flagEvalArgs.hookContext.context.betaTester,
          seatCount: flagEvalArgs.hookContext.context.seatCount,
        },
      })
    },
  })

suite.run()
