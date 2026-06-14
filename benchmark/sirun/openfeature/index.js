'use strict'

// EVP flagevaluation hot-path microbenchmark.
//
// Two variants, both exercising the real FlagEvalEVPHook + FlagEvaluationsWriter:
//
//   flag-eval-hook — the synchronous cost a flag evaluation pays for the Finally
//     hook. This is the only work charged to the caller's evaluation; it must stay
//     cheap (scalar capture + bounded enqueue), with all aggregation deferred.
//   aggregate — the off-hot-path aggregator cost (prune + canonical-key + two-tier
//     map work) that runs in the deferred drain, NOT on the evaluation path.
//     Measured for completeness so a regression in the worker path is visible too.

const assert = require('node:assert/strict')

const guard = require('../startup-guard')

// The FFE writers register a beforeExit handler on the shared dd-trace global, which
// the tracer entry point normally creates. Seed it so the writer can be exercised
// standalone here without loading the full tracer.
globalThis[Symbol.for('dd-trace')] ??= { beforeExitHandlers: new Set() }

// Stub the egress request module before the writer captures it, exactly as the
// llmobs bench does — the bench measures only in-process work, never network I/O.
const requestPath = require.resolve('../../../packages/dd-trace/src/exporters/common/request')
require.cache[requestPath] = {
  id: requestPath,
  filename: requestPath,
  loaded: true,
  exports: function noopRequest (payload, options, callback) {
    if (callback) callback(null, '', 200)
  },
}

const FlagEvaluationsWriter = require('../../../packages/dd-trace/src/openfeature/writers/flag_evaluations')
const FlagEvalEVPHook = require('../../../packages/dd-trace/src/openfeature/writers/flag_eval_hook')

const {
  VARIANT,
  COUNT,
} = process.env

const count = Number(COUNT)

// Minimal config: the writer only reads service/version/env (context) and url (base
// for the stubbed request). A plain object avoids loading the full tracer config and
// keeps the startup share under the guard ceiling.
const config = {
  service: 'benchmark',
  version: '1.0.0',
  env: 'test',
  url: new URL('http://127.0.0.1:8126'),
}

// OpenFeature Finally-hook arguments — mirrors what the @openfeature/server-sdk
// passes a `finally` hook after an evaluation.
const hookContext = {
  flagKey: 'test-flag',
  context: {
    targetingKey: 'user-123',
    plan: 'premium',
    country: 'US',
    betaTester: true,
    seatCount: 42,
  },
}
const evaluationDetails = {
  variant: 'variant-a',
  reason: 'TARGETING_MATCH',
  value: true,
  flagMetadata: { allocationKey: 'allocation-123' },
}

if (VARIANT === 'aggregate') {
  // Off-hot-path aggregator: the prune + canonical-key + two-tier map work that runs
  // in the deferred drain. A pre-built raw event matching what the hook enqueues.
  const writer = new FlagEvaluationsWriter(config)
  clearInterval(writer._periodic)

  const rawEvent = {
    flagKey: hookContext.flagKey,
    variant: evaluationDetails.variant,
    reason: 'targeting_match',
    allocationKey: 'allocation-123',
    targetingKey: hookContext.context.targetingKey,
    evalTimeMs: 1_700_000_000_000,
    attrs: hookContext.context,
  }

  // Pre-flight: one aggregation must create a full-tier bucket. Catches a silent
  // breakage where the aggregator no longer records into _full.
  writer._aggregate(rawEvent)
  assert.equal(writer._full.size, 1, '_aggregate did not create a full-tier bucket')
  writer._full.clear()
  writer._perFlagFullCount.clear()
  writer._globalCount = 0

  guard.loopStart()
  for (let i = 0; i < count; i++) {
    writer._aggregate(rawEvent)
  }
  guard.done()

  assert.ok(writer._full.size > 0, 'aggregate loop produced no buckets')
} else {
  // Eval hot path: the cost of the Finally hook itself — scalar capture + bounded
  // enqueue. Aggregation is deferred to the drain (not measured here).
  const writer = new FlagEvaluationsWriter(config)
  clearInterval(writer._periodic)
  const hook = new FlagEvalEVPHook(writer)

  // Pre-flight: one finally() must enqueue exactly one raw event. Catches a silent
  // breakage where the hook stopped enqueuing (which would make the loop measure a
  // near-empty function and falsely "pass").
  hook.finally(hookContext, evaluationDetails)
  assert.equal(writer._rawQueue.length, 1, 'hook.finally did not enqueue a raw event')
  writer._rawQueue.length = 0

  guard.loopStart()
  for (let i = 0; i < count; i++) {
    // Keep the bounded queue from filling so we measure the steady-state enqueue
    // cost, not the overflow drop path. The real drain runs on setImmediate, which
    // never fires inside this tight synchronous loop.
    if (writer._rawQueue.length >= writer._rawQueueCap) {
      writer._rawQueue.length = 0
    }
    hook.finally(hookContext, evaluationDetails)
  }
  guard.done()
}
