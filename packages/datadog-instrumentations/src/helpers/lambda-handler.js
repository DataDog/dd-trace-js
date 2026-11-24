'use strict'

const { EventEmitter } = require('node:events')
const { types: { isProxy } } = require('node:util')

const HANDLER_STREAMING = Symbol.for('aws.lambda.runtime.handler.streaming')
const HANDLER_HIGHWATERMARK = Symbol.for('aws.lambda.runtime.handler.streaming.highWaterMark')
const STREAM_RESPONSE = 'response'

/*
 * MIGRATION SCOPE (#10488): move the existing datadog-lambda-js completion policy as-is.
 * Source: https://github.com/DataDog/datadog-lambda-js/blob/bb5266a00e72eba0edcfe8d73256fe70461547c4/src/utils/handler.ts
 * Only TypeScript types, module syntax and repository formatting are changed in promisifiedHandler below.
 *
 * Known legacy corner cases intentionally left for separate behavior changes:
 * - Callback intent is inferred from handler.length and the returned value. Rest/default parameters can
 *   hide callback intent; undefined and server/socket/emitter-like returns can leave completion pending.
 * - Promise.race selects the adapter result, not AWS's native response timing. Callback/context methods
 *   are not forwarded to their originals or restored, and outer wrappers can observe that shared mutation.
 * - A handler or then getter can throw synchronously, including after calling a completion method.
 *   A callback Promise abandoned by a synchronous return/throw can later reject without an observer.
 * - Metadata, then and artifact detection read properties directly, so getters/Proxy traps can run.
 *   A null return can throw during these checks. These are the upstream checks, not a new type policy.
 * - The adapter installs methods on the supplied context. Frozen/read-only contexts, replacement methods
 *   and freezing after installation retain the shim's existing behavior; there is no defensive context view.
 * - Buffered calls use (event, context, syntheticCallback); streaming calls use (event, stream, context).
 *   Custom receivers, additional arguments and alternative buffered argument positions are not preserved.
 *
 * Record newly identified legacy completion concerns here rather than expanding this migration's policy.
 * Fixes to those behaviors belong in a separate change. A difference introduced by this port is still a bug.
 */

/**
 * @param {Function} handler Customer Lambda handler.
 * @returns {Function} Existing shim completion adapter.
 */
// Keep the upstream completion policy recognizable for this as-is migration.
/* eslint-disable unicorn/consistent-function-scoping, no-useless-assignment, unicorn/no-duplicate-if-branches */
/* eslint-disable sonarjs/prefer-immediate-return, unicorn/no-negated-condition */
function promisifiedHandler (handler) {
  // Response Stream Lambda function.
  if (handler[HANDLER_STREAMING] !== undefined && handler[HANDLER_STREAMING] === STREAM_RESPONSE) {
    return (event, responseStream, context) => {
      // This handler will always be a promise.
      const promise = handler(event, responseStream, context)
      return promise
    }
  }
  // Buffered Lambda function.
  return (event, context) => {
    // Lambda functions in node complete in one of two possible ways.
    // 1. By calling the "callback" function with a result.
    // 2. Returning a value directly from the function using a promise.
    let modifiedCallback = () => {}
    let modifiedLegacyDoneCallback = () => {}
    let modifiedLegacySucceedCallback = () => {}
    let modifiedLegacyFailCallback = () => {}
    const callbackProm = new Promise((resolve, reject) => {
      modifiedCallback = (err, result) => {
        if (err !== undefined && err !== null) {
          reject(err)
        } else {
          resolve(result)
        }
      }
      // Legacy done callback finished immediately, and doesn't wait for pending
      // event loop
      modifiedLegacyDoneCallback = (err, result) => {
        context.callbackWaitsForEmptyEventLoop = false
        if (err !== undefined && err !== null) {
          reject(err)
        } else {
          resolve(result)
        }
      }
      modifiedLegacySucceedCallback = (result) => {
        context.callbackWaitsForEmptyEventLoop = false
        resolve(result)
      }
      modifiedLegacyFailCallback = (err) => {
        context.callbackWaitsForEmptyEventLoop = false
        reject(err)
      }
    })
    context.done = modifiedLegacyDoneCallback
    context.succeed = modifiedLegacySucceedCallback
    context.fail = modifiedLegacyFailCallback
    const asyncProm = handler(event, context, modifiedCallback)
    let promise = callbackProm
    if (asyncProm !== undefined && typeof asyncProm.then === 'function') {
      // Mimics behaviour of lambda runtime, the first method of returning a result always wins.
      promise = Promise.race([callbackProm, asyncProm])
    } else if (handler.length >= 3) {
      // Handler takes a callback, wait for the callback to be called
      promise = callbackProm
    } else if (asyncProm === undefined) {
      // Handler returned nothing (implicit `undefined`) and doesn't take a callback parameter.
      // It must be relying on `context.succeed` / `context.done` / `context.fail` to signal
      // completion (e.g. `aws-serverless-express`'s `proxy()` with the default
      // `CONTEXT_SUCCEED` resolution mode, or any other fire-and-forget pattern that finishes
      // asynchronously). Wait for callbackProm rather than resolving immediately, otherwise
      // the wrapper would shortcut the function before its work finishes, which causes the
      // Lambda runtime to return an empty response and freeze the worker before any pending
      // stdout writes are flushed to CloudWatch.
      promise = callbackProm
    } else {
      // Handler returned a value directly
      // Distinguish between:
      //  - ordinary sync return value -> resolve immediately
      //  - side-effect artifact (e.g. aws-serverless-express server) -> wait for context.done
      // Heuristic: trying to detect common types of side-effect artifacts
      const looksLikeArtifact = asyncProm !== undefined &&
        typeof asyncProm === 'object' &&
        // 1. Node.js http.Server or similar
        ((typeof asyncProm.listen === 'function' && typeof asyncProm.close === 'function') ||
          // 2. EventEmitter-like (has .on and .emit)
          (typeof asyncProm.on === 'function' && typeof asyncProm.emit === 'function') ||
          // 3. Instance of EventEmitter (covers Server, Socket, etc.)
          asyncProm instanceof EventEmitter ||
          // 4. Constructor name hint
          (asyncProm.constructor && /Server|Socket|Emitter/i.test(asyncProm.constructor.name)))
      if (looksLikeArtifact) {
        // Wait for callbackProm instead (the context.done/succeed/fail will resolve it)
        promise = callbackProm
      } else {
        // Return the value directly
        promise = Promise.resolve(asyncProm)
      }
    }
    return promise
  }
}

/* eslint-enable unicorn/consistent-function-scoping, no-useless-assignment, unicorn/no-duplicate-if-branches */
/* eslint-enable sonarjs/prefer-immediate-return, unicorn/no-negated-condition */

/**
 * Reads metadata without executing application getters or Proxy traps.
 *
 * @param {unknown} target
 * @param {string | symbol} name
 */
function getDataProperty (target, name) {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) return
  while (target !== null && !isProxy(target)) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name)
    if (descriptor) return descriptor.value
    target = Object.getPrototypeOf(target)
  }
}

/**
 * Copies data properties without running customer metadata getters or Proxy traps.
 *
 * @param {Function} handler Original handler.
 * @param {Function} wrapped Wrapper to receive safe metadata.
 */
function copyHandlerMetadata (handler, wrapped) {
  // datadog-lambda-js uses arity and the runtime's streaming metadata to choose how to invoke the handler.
  Object.defineProperty(wrapped, 'length', { value: getDataProperty(handler, 'length') ?? 0 })
  for (const name of [HANDLER_STREAMING, HANDLER_HIGHWATERMARK, '_ddWrapped']) {
    const value = getDataProperty(handler, name)
    if (value !== undefined) wrapped[name] = value
  }
  if (!isProxy(handler)) {
    for (const name of Reflect.ownKeys(handler)) {
      if (name === 'arguments' || name === 'caller') continue
      const descriptor = Object.getOwnPropertyDescriptor(handler, name)
      if (!Object.hasOwn(descriptor, 'value')) continue
      const existing = Object.getOwnPropertyDescriptor(wrapped, name)
      if (existing?.configurable === false) {
        // Intrinsic function slots such as prototype cannot change their descriptor shape.
        if (existing.writable) {
          Object.defineProperty(wrapped, name, { value: descriptor.value, writable: descriptor.writable })
        }
      } else {
        Object.defineProperty(wrapped, name, descriptor)
      }
    }
  }
}

module.exports = {
  HANDLER_STREAMING,
  copyHandlerMetadata,
  getDataProperty,
  STREAM_RESPONSE,
  promisifiedHandler,
}
