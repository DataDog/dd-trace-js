'use strict'

const crypto = require('crypto')

/**
 * Mock DurableExecutionClient that provides in-memory checkpoint storage.
 * Returns checkpoint responses that mark operations as SUCCEEDED so that
 * durable operations (step, wait, etc.) can resolve without a real AWS backend.
 */
class MockDurableExecutionClient {
  constructor () {
    this._tokenCounter = 0
  }

  async getExecutionState () {
    return { Operations: [] }
  }

  async checkpoint (params) {
    this._tokenCounter++
    const operations = (params.Updates || []).map(update => ({
      Id: update.Id,
      Type: update.Type || 'STEP',
      Status: update.Action === 'START' ? 'STARTED' : 'SUCCEEDED',
      StepDetails: update.Payload ? { Result: update.Payload } : {},
    }))
    return {
      CheckpointToken: `mock-token-${this._tokenCounter}`,
      NewExecutionState: { Operations: operations },
    }
  }
}

/**
 * Mock client that resolves operations immediately in the checkpoint response.
 * Bypasses the SDK's two-phase polling (START → poll → SUCCEEDED) by returning
 * terminal status directly, which avoids the 20ms termination cooldown that
 * would otherwise kill the handler before polling completes.
 *
 * @param {string} [failOnAction] - If set, operations with this Action return FAILED
 */
class ImmediateCompletionMockClient {
  constructor (failOnAction) {
    this._tokenCounter = 0
    this._failOnAction = failOnAction
  }

  async getExecutionState () {
    return { Operations: [] }
  }

  async checkpoint (params) {
    this._tokenCounter++
    const operations = (params.Updates || []).map(update => {
      const shouldFail = this._failOnAction && update.Action === this._failOnAction
      const op = {
        Id: update.Id,
        Type: update.Type || 'STEP',
        Status: shouldFail ? 'FAILED' : 'SUCCEEDED',
        Name: update.Name,
        StepDetails: {},
        ChainedInvokeDetails: {},
      }
      if (shouldFail) {
        op.ChainedInvokeDetails = {
          Error: { ErrorType: 'InvokeError', ErrorMessage: 'Intentional invoke error' },
        }
        op.StepDetails = {
          Error: { ErrorType: 'Error', ErrorMessage: 'Intentional error' },
        }
      } else {
        op.StepDetails = update.Payload
          ? { Result: update.Payload }
          : { Result: JSON.stringify(null) }
        op.ChainedInvokeDetails = { Result: JSON.stringify(null) }
      }
      return op
    })
    return {
      CheckpointToken: `mock-token-${this._tokenCounter}`,
      NewExecutionState: { Operations: operations },
    }
  }
}

/**
 * Creates a mock Lambda context object for testing.
 * @returns {object} Mock AWS Lambda context
 */
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

/**
 * Creates a mock DurableExecutionInvocationInputWithClient event.
 * @param {object} mod - The SDK module
 * @param {MockDurableExecutionClient} mockClient - Mock client instance
 * @returns {object} Mock event
 */
function createMockEvent (mod, mockClient) {
  return new mod.DurableExecutionInvocationInputWithClient({
    DurableExecutionArn: 'arn:aws:lambda:us-east-1:123456789012:durable-execution/test-exec',
    CheckpointToken: 'initial-test-token',
    InitialExecutionState: {
      Operations: [{
        Id: crypto.createHash('md5').update('root').digest('hex').substring(0, 16),
        Type: 'EXECUTION',
        Status: 'STARTED',
        ExecutionDetails: {
          InputPayload: JSON.stringify({ testInput: true }),
        },
      }],
    },
  }, mockClient)
}

class AwsDurableExecutionSdkJsTestSetup {
  async setup (module) {
    this.mod = module
    this.mockClient = new MockDurableExecutionClient()
  }

  async teardown () {
    this.mod = undefined
    this.mockClient = undefined
  }

  /**
   * Invokes the full withDurableExecution flow with a given handler.
   * @param {Function} handlerFn - The durable handler to execute
   * @param {object} [client] - Optional mock client override (defaults to this.mockClient)
   * @returns {Promise<object>} The invocation output
   */
  async _invokeHandler (handlerFn, client) {
    const handler = this.mod.withDurableExecution(handlerFn)
    const event = createMockEvent(this.mod, client || this.mockClient)
    const context = createMockLambdaContext()
    return handler(event, context)
  }

  // --- withDurableExecution operations ---

  async withDurableExecution () {
    // The orchestrion rewriter wraps the internal runHandler function which
    // executes when the returned handler is called. The aws.durable_execution.execute
    // span covers the full handler execution lifecycle.
    const client = new ImmediateCompletionMockClient()
    return this._invokeHandler(async (event, ctx) => {
      return { status: 'completed' }
    }, client)
  }

  async withDurableExecutionError () {
    // The SDK's runHandler catches handler errors and returns a FAILED status,
    // so the span finishes normally (without error tags). We verify the span
    // is still created even on the error path.
    const client = new ImmediateCompletionMockClient()
    return this._invokeHandler(async () => {
      throw new Error('Intentional durable execution error')
    }, client)
  }

  // --- DurableContextImpl.step() operations ---

  async durableContextImplStep () {
    return this._invokeHandler(async (event, ctx) => {
      const result = await ctx.step('test-step', async () => {
        return { stepped: true }
      })
      return result
    })
  }

  async durableContextImplStepError () {
    return this._invokeHandler(async (event, ctx) => {
      const result = await ctx.step('error-step', async () => {
        throw new Error('Intentional step error')
      }, { retryStrategy: () => ({ shouldRetry: false }) })
      return result
    })
  }

  // --- DurableContextImpl.invoke() operations ---

  async durableContextImplInvoke () {
    const client = new ImmediateCompletionMockClient()
    return this._invokeHandler(async (event, ctx) => {
      const result = await ctx.invoke('test-func', 'arn:aws:lambda:us-east-1:123456789012:function:target', {})
      return result
    }, client)
  }

  async durableContextImplInvokeError () {
    const client = new ImmediateCompletionMockClient('START')
    return this._invokeHandler(async (event, ctx) => {
      const result = await ctx.invoke('error-func', 'arn:aws:lambda:us-east-1:123456789012:function:nonexistent', {})
      return result
    }, client)
  }

  // --- DurableContextImpl.runInChildContext() operations ---

  async durableContextImplRunInChildContext () {
    return this._invokeHandler(async (event, ctx) => {
      const result = await ctx.runInChildContext('test-child', async (childCtx) => {
        return { childResult: true }
      })
      return result
    })
  }

  async durableContextImplRunInChildContextError () {
    return this._invokeHandler(async (event, ctx) => {
      const result = await ctx.runInChildContext('error-child', async () => {
        throw new Error('Intentional child context error')
      }, { retryStrategy: () => ({ shouldRetry: false }) })
      return result
    })
  }

  // --- DurableContextImpl.wait() operations ---

  async durableContextImplWait () {
    const client = new ImmediateCompletionMockClient()
    return this._invokeHandler(async (event, ctx) => {
      await ctx.wait('test-wait', { seconds: 1 })
      return { waited: true }
    }, client)
  }

  async durableContextImplWaitError () {
    const client = new ImmediateCompletionMockClient()
    return this._invokeHandler(async (event, ctx) => {
      // Passing null duration triggers a synchronous TypeError in the SDK,
      // which the orchestrion wrapper captures as an error on the span.
      await ctx.wait('error-wait', null)
      return { waited: false }
    }, client)
  }

  // --- DurableContextImpl.waitForCondition() operations ---

  async durableContextImplWaitForCondition () {
    return this._invokeHandler(async (event, ctx) => {
      const result = await ctx.waitForCondition('test-condition', async () => {
        return { met: true }
      }, {
        waitStrategy: (result, attempts) => {
          if (result?.met) return { shouldContinue: false }
          return { shouldContinue: true, delay: { seconds: 1 } }
        },
      })
      return result
    })
  }

  async durableContextImplWaitForConditionError () {
    return this._invokeHandler(async (event, ctx) => {
      const result = await ctx.waitForCondition('error-condition', async () => {
        throw new Error('Intentional condition check error')
      }, {
        waitStrategy: () => ({ shouldContinue: false }),
      })
      return result
    })
  }

  // --- DurableContextImpl.waitForCallback() operations ---

  async durableContextImplWaitForCallback () {
    return this._invokeHandler(async (event, ctx) => {
      const result = await ctx.waitForCallback('test-callback', async (callbackCtx) => {
        return { submitted: true }
      })
      return result
    })
  }

  async durableContextImplWaitForCallbackError () {
    return this._invokeHandler(async (event, ctx) => {
      const result = await ctx.waitForCallback('error-callback', async () => {
        throw new Error('Intentional callback error')
      })
      return result
    })
  }

  // --- DurableContextImpl.createCallback() operations ---

  async durableContextImplCreateCallback () {
    return this._invokeHandler(async (event, ctx) => {
      const result = await ctx.createCallback('test-create-cb')
      return result
    })
  }

  async durableContextImplCreateCallbackError () {
    return this._invokeHandler(async (event, ctx) => {
      const result = await ctx.createCallback('error-create-cb', {
        serdes: {
          serialize: () => { throw new Error('Intentional serdes error') },
          deserialize: (v) => v,
        },
      })
      return result
    })
  }

  // --- DurableContextImpl.map() operations ---

  async durableContextImplMap () {
    return this._invokeHandler(async (event, ctx) => {
      const result = await ctx.map('test-map', [1, 2, 3], async (item, mapCtx) => {
        return item * 2
      })
      return result
    })
  }

  async durableContextImplMapError () {
    return this._invokeHandler(async (event, ctx) => {
      const result = await ctx.map('error-map', [1], async () => {
        throw new Error('Intentional map error')
      }, { retryStrategy: () => ({ shouldRetry: false }) })
      return result
    })
  }

  // --- DurableContextImpl.parallel() operations ---

  async durableContextImplParallel () {
    return this._invokeHandler(async (event, ctx) => {
      const result = await ctx.parallel('test-parallel', [
        async (pCtx) => { return 'branch-a' },
        async (pCtx) => { return 'branch-b' },
      ])
      return result
    })
  }

  async durableContextImplParallelError () {
    return this._invokeHandler(async (event, ctx) => {
      const result = await ctx.parallel('error-parallel', [
        async () => { throw new Error('Intentional parallel error') },
      ], { retryStrategy: () => ({ shouldRetry: false }) })
      return result
    })
  }
}

module.exports = AwsDurableExecutionSdkJsTestSetup
