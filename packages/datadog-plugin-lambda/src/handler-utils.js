'use strict'

const { EventEmitter } = require('node:events')

const { getEnvironmentVariable } = require('../../dd-trace/src/config/helper')

const HANDLER_STREAMING = Symbol.for('aws.lambda.runtime.handler.streaming')
const STREAM_RESPONSE = 'response'

const redactableKeys = new Set(['authorization', 'x-authorization', 'password', 'token'])

function noop () {}

/**
 * Converts any Lambda handler (callback, promise, sync, streaming) to a
 * function that always returns a Promise.
 *
 * @param {Function} handler
 * @returns {Function}
 */
function promisifiedHandler (handler) {
  if (handler[HANDLER_STREAMING] !== undefined && handler[HANDLER_STREAMING] === STREAM_RESPONSE) {
    return function (event, responseStream, context) {
      return handler(event, responseStream, context)
    }
  }

  return function (event, context) {
    let modifiedCallback = noop
    let modifiedLegacyDoneCallback = noop
    let modifiedLegacySucceedCallback = noop
    let modifiedLegacyFailCallback = noop

    const callbackProm = new Promise(function (resolve, reject) {
      modifiedCallback = function (err, result) {
        if (err !== undefined && err !== null) {
          reject(err)
        } else {
          resolve(result)
        }
      }
      modifiedLegacyDoneCallback = function (err, result) {
        context.callbackWaitsForEmptyEventLoop = false
        if (err !== undefined && err !== null) {
          reject(err)
        } else {
          resolve(result)
        }
      }
      modifiedLegacySucceedCallback = function (result) {
        context.callbackWaitsForEmptyEventLoop = false
        resolve(result)
      }
      modifiedLegacyFailCallback = function (err) {
        context.callbackWaitsForEmptyEventLoop = false
        reject(err)
      }
    })

    context.done = modifiedLegacyDoneCallback
    context.succeed = modifiedLegacySucceedCallback
    context.fail = modifiedLegacyFailCallback

    const asyncProm = handler(event, context, modifiedCallback)
    let promise

    if (asyncProm !== undefined && typeof asyncProm?.then === 'function') {
      promise = Promise.race([callbackProm, asyncProm])
    } else if (handler.length >= 3 || asyncProm === undefined) {
      promise = callbackProm
    } else {
      const looksLikeArtifact =
        asyncProm !== null && typeof asyncProm === 'object' &&
        ((typeof asyncProm.listen === 'function' && typeof asyncProm.close === 'function') ||
          (typeof asyncProm.on === 'function' && typeof asyncProm.emit === 'function') ||
          asyncProm instanceof EventEmitter ||
          (asyncProm.constructor && /Server|Socket|Emitter/i.test(asyncProm.constructor.name)))

      if (looksLikeArtifact) {
        promise = callbackProm
      } else {
        promise = Promise.resolve(asyncProm)
      }
    }
    return promise
  }
}

/**
 * @param {object} span
 * @param {string} key
 * @param {unknown} obj
 * @param {number} [depth]
 * @param {number} [maxDepth]
 */
function tagObject (span, key, obj, depth, maxDepth) {
  if (depth === undefined) depth = 0
  if (maxDepth === undefined) maxDepth = 10

  if (obj === null) {
    span.setTag(key, obj)
    return
  }
  if (depth >= maxDepth) {
    let str
    try {
      str = JSON.stringify(obj)
    } catch {
      return
    }
    if (str === undefined) return
    span.setTag(key, redactVal(key, str.slice(0, 5000)))
    return
  }
  depth += 1
  if (typeof obj === 'string') {
    let parsed
    try {
      parsed = JSON.parse(obj)
    } catch {
      span.setTag(key, redactVal(key, obj.slice(0, 5000)))
      return
    }
    tagObject(span, key, parsed, depth, maxDepth)
    return
  }
  if (typeof obj === 'number' || typeof obj === 'boolean') {
    span.setTag(key, obj.toString())
    return
  }
  if (typeof obj === 'object') {
    if (depth >= maxDepth) {
      let str
      try {
        str = JSON.stringify(obj)
      } catch {
        return
      }
      if (str === undefined) return
      span.setTag(key, redactVal(key, str.slice(0, 5000)))
      return
    }
    for (const [k, v] of Object.entries(obj)) {
      tagObject(span, `${key}.${k}`, v, depth, maxDepth)
    }
  }
}

/**
 * @param {unknown} lambdaResponse
 * @returns {boolean}
 */
function isBatchItemFailure (lambdaResponse) {
  return (
    typeof lambdaResponse === 'object' &&
    lambdaResponse !== null &&
    'batchItemFailures' in lambdaResponse &&
    Array.isArray(lambdaResponse.batchItemFailures)
  )
}

/**
 * @param {unknown} lambdaResponse
 * @returns {number}
 */
function batchItemFailureCount (lambdaResponse) {
  return lambdaResponse?.batchItemFailures?.length || 0
}

/**
 * @param {Record<string, unknown>} [newTags]
 * @returns {Record<string, unknown>}
 */
function updateDDTags (newTags) {
  if (!newTags) newTags = {}
  const envTags = (getEnvironmentVariable('DD_TAGS') ?? '')
    .split(',')
    .filter(function (pair) { return pair.includes(':') })
    .reduce(function (acc, pair) {
      const [key, value] = pair.split(':')
      if (key && value) acc[key] = value
      return acc
    }, {})

  return { ...envTags, ...newTags }
}

function redactVal (k, v) {
  const splitKey = k.split('.').pop() || k
  if (redactableKeys.has(splitKey)) {
    return 'redacted'
  }
  return v
}

module.exports = {
  HANDLER_STREAMING,
  STREAM_RESPONSE,
  promisifiedHandler,
  tagObject,
  isBatchItemFailure,
  batchItemFailureCount,
  updateDDTags,
}
