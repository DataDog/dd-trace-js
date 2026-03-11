'use strict'

const { channel } = require('dc-polyfill')

const aiguardPromptChannel = channel('dd-trace:vercel-ai:aiguard:prompt')
const aiguardToolCallChannel = channel('dd-trace:vercel-ai:aiguard:tool-call')

const AIGUARD_MODEL_META = Symbol('dd-trace:aiguard:model-meta')
const PROMPT_BLOCKED_ERROR_MESSAGE = 'Prompt blocked by AI Guard security policy'
const TOOL_CALL_BLOCKED_ERROR_MESSAGE = 'Tool call blocked by AI Guard security policy'

/**
 * @typedef {{ originalModel: object, fnName: string }} WrappedModelMeta
 * @typedef {{ doGenerate?: Function, doStream?: Function }} LanguageModelLike
 * @typedef {{ toolCalls?: Array<object>, content?: Array<{ type?: string }> }} ModelResult
 * @typedef {{ tools?: ArrayLike<unknown>, mode?: { tools?: ArrayLike<unknown> } }} ToolCallParams
 * @typedef {{ then?: Function }} PromiseLikeValue
 * @typedef {(...args: unknown[]) => unknown} WrappedFunction
 */

const modelCache = new WeakMap()
const wrappedModelMeta = new WeakMap()

/**
 * @param {object} aiExports
 * @returns {(fnName: string, fn: Function, supportsPrepareStep: boolean) => WrappedFunction}
 */
function createWrapWithAIGuard (aiExports) {
  /**
   * @param {string} fnName
   * @param {Function} fn
   * @param {boolean} supportsPrepareStep
   * @returns {WrappedFunction}
   */
  return function wrapWithAIGuard (fnName, fn, supportsPrepareStep) {
    return function () {
      if (!hasAIGuardSubscribers()) {
        return fn.apply(this, arguments)
      }

      const options = arguments[0]
      if (options == null || typeof options !== 'object') {
        return fn.apply(this, arguments)
      }

      const wrappedOptions = supportsPrepareStep
        ? {
            ...options,
            model: resolveAndWrapModel(options.model, aiExports, fnName),
            prepareStep: wrapPrepareStepWithAIGuard(options.prepareStep, aiExports, fnName),
            experimental_prepareStep: wrapPrepareStepWithAIGuard(
              options.experimental_prepareStep,
              aiExports,
              fnName
            ),
          }
        : {
            ...options,
            model: resolveAndWrapModel(options.model, aiExports, fnName),
          }
      const callArguments = [...arguments]

      callArguments[0] = wrappedOptions

      return fn.apply(this, callArguments)
    }
  }
}

/**
 * @param {Function | undefined} prepareStep
 * @param {object} aiExports
 * @param {string} fnName
 * @returns {Function | undefined}
 */
function wrapPrepareStepWithAIGuard (prepareStep, aiExports, fnName) {
  if (typeof prepareStep !== 'function') {
    return prepareStep
  }

  return function () {
    const result = prepareStep.apply(this, arguments)

    if (isPromiseLike(result)) {
      return result.then(stepResult => wrapPrepareStepResult(stepResult, aiExports, fnName))
    }

    return wrapPrepareStepResult(result, aiExports, fnName)
  }
}

/**
 * @param {unknown} result
 * @param {object} aiExports
 * @param {string} fnName
 * @returns {unknown}
 */
function wrapPrepareStepResult (result, aiExports, fnName) {
  if (result == null || typeof result !== 'object' || !('model' in result)) {
    return result
  }

  const wrappedModel = resolveAndWrapModel(result.model, aiExports, fnName)
  if (wrappedModel === result.model) {
    return result
  }

  return {
    ...result,
    model: wrappedModel,
  }
}

/**
 * @param {unknown} model
 * @param {object} aiExports
 * @param {string} fnName
 * @returns {unknown}
 */
function resolveAndWrapModel (model, aiExports, fnName) {
  if (typeof model === 'string') {
    const resolvedModel = resolveStringModel(model, aiExports)
    return isLanguageModelLike(resolvedModel)
      ? wrapModelWithAIGuard(resolvedModel, fnName)
      : model
  }

  return wrapModelWithAIGuard(model, fnName)
}

/**
 * @param {string} modelId
 * @param {object} aiExports
 * @returns {unknown}
 */
function resolveStringModel (modelId, aiExports) {
  const provider = globalThis.AI_SDK_DEFAULT_PROVIDER ?? aiExports.gateway
  if (provider == null || typeof provider.languageModel !== 'function') {
    return modelId
  }

  return provider.languageModel(modelId)
}

/**
 * @param {unknown} model
 * @param {string} fnName
 * @returns {unknown}
 */
function wrapModelWithAIGuard (model, fnName) {
  if (!isLanguageModelLike(model)) {
    return model
  }

  const meta = getWrappedModelMeta(model)
  if (meta?.fnName === fnName) {
    return model
  }

  const originalModel = meta?.originalModel ?? model
  let byFnName = modelCache.get(originalModel)
  if (byFnName == null) {
    byFnName = new Map()
    modelCache.set(originalModel, byFnName)
  }

  const cachedModel = byFnName.get(fnName)
  if (cachedModel) {
    return cachedModel
  }

  const wrapped = createAIGuardModelProxy(originalModel, fnName)
  const wrappedMeta = { originalModel, fnName }

  byFnName.set(fnName, wrapped)
  wrappedModelMeta.set(wrapped, wrappedMeta)

  return wrapped
}

/**
 * @param {object} model
 * @returns {WrappedModelMeta | undefined}
 */
function getWrappedModelMeta (model) {
  const directMeta = wrappedModelMeta.get(model)
  if (directMeta) {
    return directMeta
  }

  /** @type {WrappedModelMeta | undefined} */
  let proxyMeta

  try {
    proxyMeta = model[AIGUARD_MODEL_META]
  } catch {}

  return proxyMeta
}

/**
 * @param {object} originalModel
 * @param {string} fnName
 * @returns {object}
 */
function createAIGuardModelProxy (originalModel, fnName) {
  let doGenerate
  let doStream
  const meta = { originalModel, fnName }

  if (typeof originalModel.doGenerate === 'function') {
    doGenerate = wrapDoGenerate(originalModel, originalModel.doGenerate, fnName)
  }

  if (typeof originalModel.doStream === 'function') {
    doStream = wrapDoStream(originalModel, originalModel.doStream, fnName)
  }

  return new Proxy(originalModel, {
    get (target, property, receiver) {
      if (property === AIGUARD_MODEL_META) {
        return meta
      }
      if (property === 'doGenerate') {
        return doGenerate
      }
      if (property === 'doStream') {
        return doStream
      }
      return Reflect.get(target, property, receiver)
    },
  })
}

/**
 * @param {object} originalModel
 * @param {Function} originalDoGenerate
 * @param {string} fnName
 * @returns {Function}
 */
function wrapDoGenerate (originalModel, originalDoGenerate, fnName) {
  return function (params) {
    const ctx = {
      params,
      fnName,
    }

    aiguardPromptChannel.publish(ctx)

    return waitForAIGuardBlock(ctx.blockPromise, PROMPT_BLOCKED_ERROR_MESSAGE)
      .then(() => originalDoGenerate.call(originalModel, params))
      .then(result => {
        if (ctx.skipToolCallEvaluation || !shouldEvaluateToolCalls(params)) {
          return result
        }

        return evaluateToolCallsFromResult(result, fnName, ctx.baseMessages).then(() => result)
      })
  }
}

/**
 * @param {object} originalModel
 * @param {Function} originalDoStream
 * @param {string} fnName
 * @returns {Function}
 */
function wrapDoStream (originalModel, originalDoStream, fnName) {
  return function (params) {
    const ctx = {
      params,
      fnName,
    }

    aiguardPromptChannel.publish(ctx)

    return waitForAIGuardBlock(ctx.blockPromise, PROMPT_BLOCKED_ERROR_MESSAGE)
      .then(() => originalDoStream.call(originalModel, params))
      .then(result => {
        if (ctx.skipToolCallEvaluation || !shouldEvaluateToolCalls(params)) {
          return result
        }

        return wrapStreamResultWithAIGuard(result, fnName, ctx.baseMessages)
      })
  }
}

/**
 * @param {object} result
 * @param {string} fnName
 * @param {Array<object> | undefined} baseMessages
 * @returns {Promise<object>}
 */
function evaluateToolCallsFromResult (result, fnName, baseMessages) {
  const toolCalls = extractToolCallsFromResult(result)
  let chain = Promise.resolve()

  for (const toolCall of toolCalls) {
    chain = chain.then(() => {
      const ctx = {
        toolCall,
        fnName,
        baseMessages,
      }

      aiguardToolCallChannel.publish(ctx)

      return waitForAIGuardBlock(ctx.blockPromise, TOOL_CALL_BLOCKED_ERROR_MESSAGE)
    })
  }

  return chain
}

/**
 * @param {object} result
 * @param {string} fnName
 * @param {Array<object> | undefined} baseMessages
 * @returns {object}
 */
function wrapStreamResultWithAIGuard (result, fnName, baseMessages) {
  if (result?.stream == null || typeof result.stream.pipeThrough !== 'function') {
    return result
  }

  let stopped = false
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  const transform = new TransformStream({
    transform (chunk, controller) {
      if (stopped) {
        return
      }

      if (!isCompletedToolCallChunk(chunk)) {
        controller.enqueue(chunk)
        return
      }

      const ctx = {
        toolCall: chunk,
        fnName,
        baseMessages,
      }

      aiguardToolCallChannel.publish(ctx)

      return waitForAIGuardBlock(ctx.blockPromise, TOOL_CALL_BLOCKED_ERROR_MESSAGE)
        .then(() => {
          controller.enqueue(chunk)
        })
        .catch(error => {
          stopped = true
          controller.enqueue({
            type: 'error',
            error: sanitizeAIGuardError(error, TOOL_CALL_BLOCKED_ERROR_MESSAGE),
          })
          controller.terminate()
        })
    },
  })

  return {
    ...result,
    stream: result.stream.pipeThrough(transform),
  }
}

/**
 * @param {unknown} error
 * @param {string} defaultMessage
 * @returns {Error}
 */
function sanitizeAIGuardError (error, defaultMessage) {
  const errorMessage = getErrorMessage(error)

  if (typeof errorMessage === 'string' && errorMessage.length > 0) {
    return new Error(errorMessage)
  }

  return new Error(defaultMessage)
}

/**
 * @param {Promise<unknown> | undefined} blockPromise
 * @param {string} defaultMessage
 * @returns {Promise<void>}
 */
function waitForAIGuardBlock (blockPromise, defaultMessage) {
  if (blockPromise == null) {
    return Promise.resolve()
  }

  return blockPromise.then(
    () => {},
    error => { throw sanitizeAIGuardError(error, defaultMessage) }
  )
}

/**
 * @param {unknown} result
 * @returns {Array<object>}
 */
function extractToolCallsFromResult (result) {
  const modelResult = /** @type {ModelResult} */ (result)

  if (Array.isArray(modelResult.toolCalls) && modelResult.toolCalls.length > 0) {
    return modelResult.toolCalls.filter(isCompletedToolCall)
  }

  if (!Array.isArray(modelResult.content)) {
    return []
  }

  const toolCalls = []
  for (const part of modelResult.content) {
    if (part?.type === 'tool-call' && isCompletedToolCall(part)) {
      toolCalls.push(part)
    }
  }

  return toolCalls
}

/**
 * @param {unknown} toolCall
 * @returns {boolean}
 */
function isCompletedToolCall (toolCall) {
  if (toolCall == null || typeof toolCall !== 'object') {
    return false
  }

  return hasNonEmptyString(getToolCallId(toolCall)) && hasNonEmptyString(getToolCallName(toolCall))
}

/**
 * @param {unknown} chunk
 * @returns {boolean}
 */
function isCompletedToolCallChunk (chunk) {
  if (chunk == null || typeof chunk !== 'object') {
    return false
  }

  return chunk.type === 'tool-call' && isCompletedToolCall(chunk)
}

/**
 * @param {object} toolCall
 * @returns {unknown}
 */
function getToolCallId (toolCall) {
  return toolCall.toolCallId ?? toolCall.id
}

/**
 * @param {object} toolCall
 * @returns {unknown}
 */
function getToolCallName (toolCall) {
  return toolCall.toolName ?? toolCall.function?.name ?? toolCall.name
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function hasNonEmptyString (value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * @param {unknown} params
 * @returns {boolean}
 */
function shouldEvaluateToolCalls (params) {
  const toolCallParams = /** @type {ToolCallParams} */ (params)
  const tools = toolCallParams.tools ?? toolCallParams.mode?.tools
  return (tools?.length ?? 0) > 0
}

/**
 * @returns {boolean}
 */
function hasAIGuardSubscribers () {
  return aiguardPromptChannel.hasSubscribers || aiguardToolCallChannel.hasSubscribers
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPromiseLike (value) {
  const promiseLikeValue = /** @type {PromiseLikeValue} */ (value)
  return value != null && typeof promiseLikeValue.then === 'function'
}

/**
 * @param {unknown} model
 * @returns {boolean}
 */
function isLanguageModelLike (model) {
  if (model == null || typeof model !== 'object') {
    return false
  }

  const languageModel = /** @type {LanguageModelLike} */ (model)
  return typeof languageModel.doGenerate === 'function' || typeof languageModel.doStream === 'function'
}

/**
 * @param {unknown} error
 * @returns {string | undefined}
 */
function getErrorMessage (error) {
  if (error == null || typeof error !== 'object') {
    return
  }

  const errorWithMessage = /** @type {{ message?: string }} */ (error)
  return errorWithMessage.message
}

module.exports = {
  createWrapWithAIGuard,
}
