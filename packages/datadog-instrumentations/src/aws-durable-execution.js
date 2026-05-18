'use strict'

const { channel, addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('apm:aws-durable-execution:operation:start')
const finishCh = channel('apm:aws-durable-execution:operation:finish')
const errorCh = channel('apm:aws-durable-execution:operation:error')

const operationMethods = [
  { method: 'step', type: 'step' },
  { method: 'wait', type: 'wait' },
  { method: 'invoke', type: 'invoke' },
  { method: 'runInChildContext', type: 'run_in_child_context' },
  { method: 'map', type: 'map' },
  { method: 'parallel', type: 'parallel' },
  { method: 'waitForCallback', type: 'wait_for_callback' },
  { method: 'waitForCondition', type: 'wait_for_condition' },
  { method: 'createCallback', type: 'create_callback' }
]

addHook({ name: '@aws/durable-execution-sdk-js', versions: ['>=1'] }, (mod) => {
  shimmer.wrap(mod, 'withDurableExecution', wrapWithDurableExecution)
  return mod
})

function wrapWithDurableExecution (originalWithDurableExecution) {
  return function wrappedWithDurableExecution (handler, config) {
    let executionArn

    const wrappedHandler = function (event, durableContext) {
      wrapDurableContextMethods(durableContext, executionArn)
      return handler.call(this, event, durableContext)
    }

    const lambdaHandler = originalWithDurableExecution.call(this, wrappedHandler, config)

    return function wrappedLambdaHandler (event, lambdaContext) {
      if (event) {
        executionArn = event.DurableExecutionArn
      }
      return lambdaHandler.apply(this, arguments)
    }
  }
}

function wrapDurableContextMethods (durableContext, executionArn) {
  for (const { method, type } of operationMethods) {
    if (typeof durableContext[method] !== 'function') continue
    if (durableContext[method].__wrapped) continue

    shimmer.wrap(durableContext, method, wrapOperation(type, executionArn, durableContext))
  }
}

function wrapOperation (operationType, executionArn, durableContext) {
  return function (original) {
    const wrapped = function () {
      if (!startCh.hasSubscribers) return original.apply(this, arguments)

      const operationName = typeof arguments[0] === 'string' ? arguments[0] : undefined
      const ctx = {
        operationType,
        operationName,
        executionArn,
        requestId: durableContext.lambdaContext?.awsRequestId,
        functionName: durableContext.lambdaContext?.functionName
      }

      return startCh.runStores(ctx, () => {
        try {
          const result = original.apply(this, arguments)

          result.then(
            () => {
              finishCh.publish(ctx)
            },
            (err) => {
              ctx.error = err
              errorCh.publish(ctx)
              finishCh.publish(ctx)
            }
          )

          return result
        } catch (err) {
          ctx.error = err
          errorCh.publish(ctx)
          finishCh.publish(ctx)
          throw err
        }
      })
    }

    wrapped.__wrapped = true
    return wrapped
  }
}
