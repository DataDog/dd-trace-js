'use strict'

const assert = require('node:assert/strict')

const { maybeSaveTraceContextCheckpoint } = require('../src/trace-checkpoint')

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

    const tracer = {
      inject (_span, _format, headers) {
        headers['x-datadog-trace-id'] = '123'
        headers['x-datadog-parent-id'] = '456'
      },
    }

    const savePromise = maybeSaveTraceContextCheckpoint(
      tracer,
      { context: () => ({}) },
      { checkpoint: checkpointManager },
      '999',
      {
        DurableExecutionArn: 'arn:aws:lambda:us-east-1:123456789012:durable-execution/test-exec',
        InitialExecutionState: { Operations: [] },
      },
      { Status: 'PENDING' },
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

  it('does not save a new checkpoint when only tracestate dd.p changes', async () => {
    const recordedActions = []
    const checkpointManager = {
      isTerminating: false,
      checkpoint (_stepId, update) {
        recordedActions.push(update.Action)
        return Promise.resolve()
      },
    }

    const currentHeaders = {
      'x-datadog-trace-id': '123',
      'x-datadog-parent-id': '999',
      'x-datadog-tags': '_dd.p.tid=5d89697714596e3',
      traceparent: '00-05d89697714596e3000000000000007b-00000000000003e7-01',
      tracestate: 'dd=t.tid:5d89697714596e3;s:1;p:2a9e29982216c13a',
    }

    const previousCheckpointHeaders = {
      'x-datadog-trace-id': '123',
      'x-datadog-parent-id': '111',
      'x-datadog-tags': '_dd.p.tid=5d89697714596e3',
      traceparent: '00-05d89697714596e3000000000000007b-000000000000006f-01',
      tracestate: 'dd=t.tid:5d89697714596e3;s:1;p:1d136d04e3515ce8',
    }

    const tracer = {
      inject (_span, _format, headers) {
        Object.assign(headers, currentHeaders)
      },
    }

    await maybeSaveTraceContextCheckpoint(
      tracer,
      { context: () => ({}) },
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
      { Status: 'PENDING' },
    )

    assert.deepEqual(recordedActions, [])
  })
})
