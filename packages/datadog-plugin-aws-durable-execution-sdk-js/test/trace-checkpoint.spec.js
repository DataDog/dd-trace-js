'use strict'

const assert = require('node:assert/strict')

const id = require('../../dd-trace/src/id')
const SpanContext = require('../../dd-trace/src/opentracing/span_context')
const { getConfigFresh } = require('../../dd-trace/test/helpers/config')

const { saveTraceContextCheckpointIfUpdated } = require('../src/trace-checkpoint')

describe('trace-checkpoint', () => {
  it('queues START and SUCCEED before termination flips the manager state', async () => {
    const recordedUpdates = []
    const checkpointManager = {
      isTerminating: false,
      checkpoint (_stepId, update) {
        if (this.isTerminating) {
          return new Promise(() => {})
        }
        recordedUpdates.push(update)
        return Promise.resolve()
      },
    }

    const spanContext = new SpanContext({
      traceId: id('123', 10),
      spanId: id('456', 10),
      isRemote: false,
      trace: { started: [], finished: [], tags: {} },
    })

    const savePromise = saveTraceContextCheckpointIfUpdated(
      { _config: getConfigFresh() },
      { context: () => spanContext },
      { checkpoint: checkpointManager },
      '999',
      {
        DurableExecutionArn: 'arn:aws:lambda:us-east-1:123456789012:durable-execution/test-exec',
        InitialExecutionState: { Operations: [] },
      },
    )

    // Simulate termination starting immediately after save is triggered.
    checkpointManager.isTerminating = true

    await Promise.race([
      savePromise,
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('checkpoint save timed out')), 100)
      }),
    ])

    assert.deepEqual(recordedUpdates.map(update => update.Action), ['START', 'SUCCEED'])
    assert.equal(recordedUpdates[0]?.Name, '_datadog_0')
    assert.equal(recordedUpdates[1]?.Name, '_datadog_0')
  })

  it('does not save a new checkpoint when only x-datadog-parent-id changes', async () => {
    const recordedActions = []
    const checkpointManager = {
      isTerminating: false,
      checkpoint (_stepId, update) {
        recordedActions.push(update.Action)
        return Promise.resolve()
      },
    }

    // Previous checkpoint: same non-parent-id fields the propagator will emit
    // below; only parent-id differs. Key order matches the propagator's
    // emission order (trace-id, parent-id, sampling-priority, tags).
    const previousCheckpointHeaders = {
      'x-datadog-trace-id': '123',
      'x-datadog-parent-id': '111',
      'x-datadog-sampling-priority': '1',
      'x-datadog-tags': '_dd.p.tid=5d89697714596e3',
    }

    const spanContext = new SpanContext({
      traceId: id('123', 10),
      spanId: id('456', 10),
      isRemote: false,
      sampling: { priority: 1 },
      trace: { started: [], finished: [], tags: { '_dd.p.tid': '5d89697714596e3' } },
    })

    await saveTraceContextCheckpointIfUpdated(
      { _config: getConfigFresh() },
      { context: () => spanContext },
      { checkpoint: checkpointManager },
      '999',
      {
        DurableExecutionArn: 'arn:aws:lambda:us-east-1:123456789012:durable-execution/test-exec',
        InitialExecutionState: {
          Operations: [
            {
              Id: 'trace-checkpoint-0',
              Name: '_datadog_0',
              Status: 'SUCCEEDED',
              Payload: JSON.stringify(previousCheckpointHeaders),
            },
          ],
        },
      },
    )

    assert.deepEqual(recordedActions, [])
  })

  it('does not leak ot-baggage-* headers into the checkpoint payload', async () => {
    const recordedUpdates = []
    const checkpointManager = {
      checkpoint (_stepId, update) {
        recordedUpdates.push(update)
        return Promise.resolve()
      },
    }

    const config = getConfigFresh()
    config.legacyBaggageEnabled = true

    const spanContext = new SpanContext({
      traceId: id('123', 10),
      spanId: id('456', 10),
      isRemote: false,
      baggageItems: { secret: 'do-not-propagate' },
      trace: { started: [], finished: [], tags: {} },
    })

    await saveTraceContextCheckpointIfUpdated(
      { _config: config },
      { context: () => spanContext },
      { checkpoint: checkpointManager },
      '999',
      {
        DurableExecutionArn: 'arn:aws:lambda:us-east-1:123456789012:durable-execution/test-exec',
        InitialExecutionState: { Operations: [] },
      },
    )

    const succeed = recordedUpdates.find(update => update.Action === 'SUCCEED')
    assert.ok(succeed, 'expected SUCCEED checkpoint to be recorded')
    const payload = JSON.parse(succeed.Payload)
    for (const key of Object.keys(payload)) {
      assert.doesNotMatch(key, /^ot-baggage-/, `unexpected baggage header in checkpoint payload: ${key}`)
    }
    assert.equal(payload['x-datadog-trace-id'], '123')
  })
})
