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

  it('saves when the current context adds a field the prior checkpoint lacked', async () => {
    const recordedUpdates = []
    const checkpointManager = {
      checkpoint (_stepId, update) {
        recordedUpdates.push(update)
        return Promise.resolve()
      },
    }

    // Prior checkpoint shares every field the current span emits EXCEPT x-datadog-tags, which the
    // current span introduces. A current key absent from the previous payload is a new value to
    // propagate, so a new checkpoint must be written.
    const previousCheckpointHeaders = {
      'x-datadog-trace-id': '123',
      'x-datadog-parent-id': '111',
      'x-datadog-sampling-priority': '1',
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

    const succeed = recordedUpdates.find(update => update.Action === 'SUCCEED')
    assert.equal(succeed?.Name, '_datadog_1', 'a new x-datadog-tags field must write a new checkpoint')
  })

  it('does not save when keys are missing and no new fields are added', async () => {
    const recordedActions = []
    const checkpointManager = {
      checkpoint (_stepId, update) {
        recordedActions.push(update.Action)
        return Promise.resolve()
      },
    }

    // Prior checkpoint carries an extra x-datadog-tags the current span no longer emits; every
    // value the current span DOES emit still matches. Re-saving would only drop the tags the
    // previous checkpoint already holds, so we must skip.
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
      trace: { started: [], finished: [], tags: {} },
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

  it('writes an incrementing _datadog_1 that carries the prior anchor when context changed', async () => {
    const recordedUpdates = []
    const checkpointManager = {
      checkpoint (_stepId, update) {
        recordedUpdates.push(update)
        return Promise.resolve()
      },
    }

    // Prior checkpoint anchored parent-id 111 on a *different* trace (999). The non-parent-id
    // fields differ from what the current span emits, so a brand-new checkpoint must be written —
    // numbered _datadog_1 and reusing the prior anchor rather than the current span id (456).
    const previousCheckpointHeaders = {
      'x-datadog-trace-id': '999',
      'x-datadog-parent-id': '111',
      'x-datadog-sampling-priority': '1',
    }

    const spanContext = new SpanContext({
      traceId: id('123', 10),
      spanId: id('456', 10),
      isRemote: false,
      sampling: { priority: 1 },
      trace: { started: [], finished: [], tags: {} },
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

    const succeed = recordedUpdates.find(update => update.Action === 'SUCCEED')
    assert.equal(succeed?.Name, '_datadog_1')
    const payload = JSON.parse(succeed.Payload)
    assert.deepEqual(
      { traceId: payload['x-datadog-trace-id'], parentId: payload['x-datadog-parent-id'] },
      { traceId: '123', parentId: '111' }
    )
  })

  it('skips the save when the prior checkpoint payload is not valid JSON', async () => {
    const recordedActions = []
    const checkpointManager = {
      checkpoint (_stepId, update) {
        recordedActions.push(update.Action)
        return Promise.resolve()
      },
    }

    const spanContext = new SpanContext({
      traceId: id('123', 10),
      spanId: id('456', 10),
      isRemote: false,
      trace: { started: [], finished: [], tags: {} },
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
            { Id: 'trace-checkpoint-0', Name: '_datadog_0', Status: 'SUCCEEDED', Payload: '{not valid json' },
          ],
        },
      },
    )

    assert.deepEqual(recordedActions, [])
  })

  it('propagates checkpoint-manager errors (the fire-and-forget caller swallows them)', async () => {
    const checkpointManager = {
      checkpoint () { throw new Error('SDK checkpoint failure') },
    }

    const spanContext = new SpanContext({
      traceId: id('123', 10),
      spanId: id('456', 10),
      isRemote: false,
      trace: { started: [], finished: [], tags: {} },
    })

    // This helper does not swallow — its caller (handler.js maybeSaveCheckpoint) owns the
    // best-effort boundary. We assert the error surfaces here so that contract stays explicit.
    await assert.rejects(
      saveTraceContextCheckpointIfUpdated(
        { _config: getConfigFresh() },
        { context: () => spanContext },
        { checkpoint: checkpointManager },
        '999',
        {
          DurableExecutionArn: 'arn:aws:lambda:us-east-1:123456789012:durable-execution/test-exec',
          InitialExecutionState: { Operations: [] },
        },
      ),
      { message: 'SDK checkpoint failure' },
    )
  })
})
