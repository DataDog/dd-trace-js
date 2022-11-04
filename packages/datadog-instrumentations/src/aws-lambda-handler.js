'use strict'

const path = require('path')

const { extractModuleRootAndHandler, splitHandlerString } = require('./helpers/lambda')
const { addHook, channel } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const _lambdaTaskRoot = process.env.LAMBDA_TASK_ROOT
const originalLambdaHandler = process.env.DD_LAMBDA_HANDLER
const [_moduleRoot, _moduleAndHandler] = extractModuleRootAndHandler(originalLambdaHandler)
const [_module, _handlerPath] = splitHandlerString(_moduleAndHandler);


function wrapLambdaModule (lambdaModule) {
  shimmer.wrap(lambdaModule, _handlerPath, wrapLambdaHandler)  
  
  return lambdaModule
}

function wrapLambdaHandler (lambdaHandler) {
  return function (...args) {
    const context = args[1]
    const remainingTime = context.getRemainingTimeInMillis()
    const wrapped = lambdaHandler.apply(this, args)
    const dc = channel('_ddtrace:tracer:killSpan')
    setTimeout(() => {
      dc.publish(undefined);
    }, remainingTime - 100)

    return wrapped
  }
}

const lambdaStylePath = path.resolve(_lambdaTaskRoot, _moduleRoot, _module) + '.js'

addHook({ name: lambdaStylePath }, wrapLambdaModule)
