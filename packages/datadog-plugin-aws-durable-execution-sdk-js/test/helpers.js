'use strict'

const crypto = require('node:crypto')

const TEST_EXEC_ARN = 'arn:aws:lambda:us-east-1:123456789012:durable-execution/test-exec'
const TEST_FUNC_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:target'
const ROOT_OP_ID = crypto.createHash('md5').update('root').digest('hex').substring(0, 16)

let _mod, _defaultClient

/**
 * Mock DurableExecutionClient.
 *
 * Modes:
 * - `polling` (default): START → STARTED, else SUCCEEDED — mimics real two-phase polling.
 * - `immediate`: always SUCCEEDED — bypasses the SDK's 20ms termination cooldown that
 *   would otherwise kill the handler before polling completes.
 * - `retry-pending`: RETRY → PENDING (with Error/NextAttemptTimestamp), else like polling —
 *   used to exercise the checkpoint plugin's RETRY error stamping.
 *
 * `failOnAction`: when matched against an update's Action, returns FAILED with error details.
 */
class MockClient {
  constructor ({ mode = 'polling', failOnAction } = {}) {
    this._tokenCounter = 0
    this._mode = mode
    this._failOnAction = failOnAction
  }

  async getExecutionState () {
    return { Operations: [] }
  }

  async checkpoint (params) {
    this._tokenCounter++
    const operations = (params.Updates || []).map(u => this._buildOp(u))
    return {
      CheckpointToken: `mock-token-${this._tokenCounter}`,
      NewExecutionState: { Operations: operations },
    }
  }

  _buildOp (u) {
    const op = { Id: u.Id, Type: u.Type || 'STEP' }
    const shouldFail = this._failOnAction && u.Action === this._failOnAction

    if (shouldFail) {
      op.Status = 'FAILED'
      op.Name = u.Name
      op.StepDetails = { Error: { ErrorType: 'Error', ErrorMessage: 'Intentional error' } }
      op.ChainedInvokeDetails = { Error: { ErrorType: 'InvokeError', ErrorMessage: 'Intentional invoke error' } }
      return op
    }
    if (this._mode === 'immediate') {
      op.Status = 'SUCCEEDED'
      op.Name = u.Name
      op.StepDetails = u.Payload ? { Result: u.Payload } : { Result: JSON.stringify(null) }
      op.ChainedInvokeDetails = { Result: JSON.stringify(null) }
      return op
    }
    if (this._mode === 'retry-pending' && u.Action === 'RETRY') {
      op.Status = 'PENDING'
      op.StepDetails = { Error: u.Error, NextAttemptTimestamp: Date.now() + 60_000 }
      return op
    }
    op.Status = u.Action === 'START' ? 'STARTED' : 'SUCCEEDED'
    op.StepDetails = u.Payload ? { Result: u.Payload } : {}
    return op
  }
}

function setup (mod) {
  _mod = mod
  _defaultClient = new MockClient()
}

function teardown () {
  _mod = undefined
  _defaultClient = undefined
}

function createMockLambdaContext () {
  const startTime = Date.now()
  return {
    awsRequestId: `test-req-${startTime}`,
    functionName: 'test-durable-function',
    functionVersion: '$LATEST',
    invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:test-durable-function',
    memoryLimitInMB: '128',
    logGroupName: '/aws/lambda/test-durable-function',
    logStreamName: '2024/01/01/[$LATEST]test',
    getRemainingTimeInMillis: () => Math.max(0, 30000 - (Date.now() - startTime)),
    tenantId: 'test-tenant',
  }
}

function createMockEvent (mockClient, extraOps = []) {
  return new _mod.DurableExecutionInvocationInputWithClient({
    DurableExecutionArn: TEST_EXEC_ARN,
    CheckpointToken: 'initial-test-token',
    InitialExecutionState: {
      Operations: [
        {
          Id: ROOT_OP_ID,
          Type: 'EXECUTION',
          Status: 'STARTED',
          ExecutionDetails: { InputPayload: JSON.stringify({ testInput: true }) },
        },
        ...extraOps,
      ],
    },
  }, mockClient)
}

/**
 * Invokes the SDK's `withDurableExecution` handler with the given closure.
 *
 * @param {Function} handlerFn - `async (event, ctx) => any`
 * @param {object} [opts]
 * @param {'polling'|'immediate'|'retry-pending'} [opts.mode] - shortcut to construct a `MockClient`
 *   with this mode. Ignored if `mockClient` is provided.
 * @param {string} [opts.failOnAction] - paired with `mode`; updates with this Action return FAILED
 * @param {MockClient} [opts.mockClient] - overrides the default polling-mode client
 * @param {Array<object>} [opts.extraOps] - extra Operations to seed (e.g. for replay)
 * @returns {Promise<object>} The SDK's invocation output
 */
async function invokeHandler (handlerFn, { mode, failOnAction, mockClient, extraOps } = {}) {
  const client = mockClient || (mode ? new MockClient({ mode, failOnAction }) : _defaultClient)
  const handler = _mod.withDurableExecution(handlerFn)
  const event = createMockEvent(client, extraOps)
  return handler(event, createMockLambdaContext())
}

module.exports = {
  MockClient,
  TEST_EXEC_ARN,
  TEST_FUNC_ARN,
  invokeHandler,
  setup,
  teardown,
}
