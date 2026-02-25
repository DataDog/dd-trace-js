'use strict'

const session = require('../session')
const { collectObjectProperties } = require('./collector')
const { processRawState, processRemoteObject } = require('./processor')

const BIGINT_MAX = (1n << 256n) - 1n

module.exports = {
  getLocalStateForCallFrame,
  evaluateCaptureExpressions,
}

/**
 * @typedef {object} CaptureLimits - Fully resolved capture limits (all fallbacks already applied)
 * @property {number} maxReferenceDepth - The maximum depth of the object to traverse
 * @property {number} maxCollectionSize - The maximum size of a collection to include in the snapshot
 * @property {number} maxFieldCount - The maximum number of properties on an object to include in the snapshot
 * @property {number} maxLength - The maximum length of a string to include in the snapshot
 */

/**
 * Get the local state for a call frame.
 *
 * @param {import('inspector').Debugger.CallFrame} callFrame - The call frame to get the local state for
 * @param {CaptureLimits} limits - The capture limits
 * @param {bigint} [deadlineNs] - The deadline in nanoseconds compared to `process.hrtime.bigint()`. Defaults to
 *   {@link BIGINT_MAX}. If the deadline is reached, the snapshot will be truncated.
 * @returns {Promise<{ processLocalState: () => ReturnType<typeof processRawState>, fatalErrors: Error[] }>} The local
 *   state for the call frame
 */
async function getLocalStateForCallFrame (callFrame, limits, deadlineNs = BIGINT_MAX) {
  const { maxReferenceDepth, maxCollectionSize, maxFieldCount, maxLength } = limits
  /** @type {{ deadlineReached: boolean, fatalErrors: Error[] }} */
  const ctx = { deadlineReached: false, fatalErrors: [] }
  const opts = { maxReferenceDepth, maxCollectionSize, maxFieldCount, deadlineNs, ctx }
  const rawState = []
  /** @type {ReturnType<typeof processRawState> | null} */
  let processedState = null

  for (const scope of callFrame.scopeChain) {
    if (scope.type === 'global') continue // The global scope is too noisy
    const { objectId } = scope.object
    if (objectId === undefined) continue // I haven't seen this happen, but according to the types it's possible
    try {
      // The objectId for a scope points to a pseudo-object whose properties are the actual variables in the scope.
      // This is why we can just call `collectObjectProperties` directly and expect it to return the in-scope variables
      // as an array.
      // eslint-disable-next-line no-await-in-loop
      rawState.push(...await collectObjectProperties(objectId, opts))
    } catch (err) {
      ctx.fatalErrors.push(new Error(
        `Error getting local state for closure scope (type: ${scope.type}). ` +
        'Future snapshots for existing probes in this location will be skipped until the probes are re-applied',
        { cause: err } // TODO: The cause is not used by the backend
      ))
    }
    if (ctx.deadlineReached === true) break // TODO: Bad UX; Variables in remaining scopes are silently dropped
  }

  // Delay calling `processRawState` so caller can resume the main thread before processing `rawState`
  return {
    processLocalState () {
      processedState = processedState ?? processRawState(rawState, maxLength)
      return processedState
    },
    fatalErrors: ctx.fatalErrors,
  }
}

/**
 * @typedef {object} CompiledCaptureExpression
 * @property {string} name - The name of the expression (used as key in snapshot)
 * @property {string} expression - The compiled expression string to evaluate
 * @property {CaptureLimits} limits - Fully resolved capture limits (precomputed at probe setup)
 */

/**
 * @typedef {object} CaptureExpressionResult
 * @property {() => Record<string, ReturnType<typeof processRemoteObject>>} processCaptureExpressions - Callback to
 *   process raw data into snapshot format
 * @property {{ expr: string, message: string }[]} evaluationErrors - Transient errors from expression evaluation
 *   (safe to retry)
 * @property {Error[]} fatalErrors - Fatal errors that should disable capture expressions for this probe permanently
 */

/**
 * @typedef {object} EvaluateOnCallFrameResult
 * @property {import('./processor').RemoteObjectWithProperties} result - The result of the evaluation
 * @property {import('inspector').Runtime.ExceptionDetails} [exceptionDetails] - Exception details if evaluation failed
 */

/**
 * Evaluate capture expressions for a call frame.
 *
 * Collects raw data while paused, returns a callback to process after resume.
 *
 * @param {import('inspector').Debugger.CallFrame} callFrame - The call frame to evaluate expressions on
 * @param {CompiledCaptureExpression[]} expressions - The compiled expressions with precomputed capture limits
 * @param {bigint} [deadlineNs] - The deadline in nanoseconds. Defaults to {@link BIGINT_MAX}. If the deadline is
 *   reached, the snapshot will be truncated.
 * @returns {Promise<CaptureExpressionResult>} Raw results with deferred processing callback
 */
async function evaluateCaptureExpressions (callFrame, expressions, deadlineNs = BIGINT_MAX) {
  /** @type {{ name: string, remoteObject: object, maxLength: number }[]} */
  const rawResults = []
  /** @type {{ expr: string, message: string }[]} */
  const evaluationErrors = []
  /** @type {Error[]} */
  const fatalErrors = []
  /** @type {Record<string, ReturnType<typeof processRemoteObject>> | null} */
  let processedResult = null

  for (let i = 0; i < expressions.length; i++) {
    const { name, expression, limits } = expressions[i]
    const { maxReferenceDepth, maxCollectionSize, maxFieldCount, maxLength } = limits

    try {
      const { result, exceptionDetails } = /** @type {EvaluateOnCallFrameResult} */ (
        // eslint-disable-next-line no-await-in-loop
        await session.post('Debugger.evaluateOnCallFrame', {
          callFrameId: callFrame.callFrameId,
          expression,
        })
      )

      // Handle evaluation exceptions (maybe transient - bad expression, undefined var, etc.)
      if (exceptionDetails) {
        evaluationErrors.push({ expr: name, message: extractErrorMessage(exceptionDetails) })
        continue
      }

      // Collect raw properties for objects/functions while still paused
      if ((result.type === 'object' || result.type === 'function') && result.objectId && maxReferenceDepth > 0) {
        const ctx = { deadlineReached: false, fatalErrors: [] }
        const isCollection = result.subtype === 'array' || result.subtype === 'typedarray'

        // eslint-disable-next-line no-await-in-loop
        result.properties = await collectObjectProperties(
          result.objectId,
          {
            // The expression result itself is depth 0, so we subtract 1 when collecting its properties (depth 1+)
            maxReferenceDepth: maxReferenceDepth - 1,
            maxCollectionSize,
            maxFieldCount,
            deadlineNs,
            ctx,
          },
          0,
          isCollection
        )

        // Propagate fatal errors from nested collection
        if (ctx.fatalErrors.length > 0) {
          fatalErrors.push(...ctx.fatalErrors)
        }

        if (ctx.deadlineReached === true) {
          // Add the current expression (properties may be incomplete due to timeout)
          rawResults.push({ name, remoteObject: result, maxLength })
          // Add stub entries for remaining uncaptured expressions
          for (let j = i + 1; j < expressions.length; j++) {
            rawResults.push({
              name: expressions[j].name,
              remoteObject: { notCapturedReason: 'timeout' },
              maxLength: 0,
            })
          }
          break
        }
      }

      rawResults.push({ name, remoteObject: result, maxLength })
    } catch (err) {
      fatalErrors.push(new Error(
        `Error capturing expression "${name}". ` +
        'Capture expressions for this probe will be skipped until the probe is re-applied',
        { cause: err } // TODO: The cause is not used by the backend
      ))
    }
  }

  // Delay calling `processRemoteObject` so caller can resume the main thread before processing `remoteObject`
  return {
    processCaptureExpressions () {
      if (processedResult !== null) return processedResult

      processedResult = {}
      for (const { name, remoteObject, maxLength } of rawResults) {
        // If the remote object has notCapturedReason (e.g., timeout), use it as-is without processing
        processedResult[name] = remoteObject.notCapturedReason === undefined
          ? processRemoteObject(remoteObject, maxLength)
          : remoteObject
      }

      return processedResult
    },
    evaluationErrors,
    fatalErrors,
  }
}

/**
 * Extract the error message from the exception details.
 *
 * @param {import('inspector').Runtime.ExceptionDetails} exceptionDetails - The exception details
 * @returns {string} The error message
 */
function extractErrorMessage (exceptionDetails) {
  const description = exceptionDetails.exception?.description
  if (!description) return 'Unknown evaluation error'
  const startOfStackTraceIndex = description.indexOf('\n    at ')
  if (startOfStackTraceIndex === -1) return description
  return description.slice(0, startOfStackTraceIndex)
}
