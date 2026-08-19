'use strict'

const { HTTP_CLIENT_IP, HTTP_USERAGENT, NETWORK_CLIENT_IP } = require('../../../../ext/tags')
const clone = require('../../../../vendor/dist/rfdc')({ proto: false, circles: false })
const { USER_ID, USER_SESSION_ID } = require('../appsec/addresses')
const { getActiveRequest } = require('../appsec/store')
const { keepTrace } = require('../priority_sampler')
const { extractIp } = require('../plugins/util/ip_extractor')
const { AI_GUARD } = require('../standalone/product')
const telemetryMetrics = require('../telemetry/metrics')
const TAGS = require('./tags')

const ALLOW = 'ALLOW'

/** @typedef {import('../../../../index').aiguard.Message} Message */
/** @typedef {import('../opentracing/span')} Span */

/**
 * @typedef {object} EvaluationResponse
 * @property {string} action
 * @property {string|undefined} reason
 * @property {Array<unknown>} tags
 * @property {Array<unknown>} sdsFindings
 * @property {Record<string, unknown>} tagProbabilities
 * @property {boolean} hasTagProbabilities
 * @property {boolean} blockingEnabled
 */

/**
 * @typedef {object} EvaluationOutcome
 * @property {{ action: string, reason: string|undefined, tags: Array<unknown>,
 *   tagProbabilities: Record<string, unknown>, sds: Array<unknown> }} result
 * @property {boolean} shouldBlock
 * @property {boolean} hasTagProbabilities
 */

/**
 * @typedef {object} EvaluationMetaStruct
 * @property {Message[]} messages
 * @property {Array<unknown>} [attack_categories]
 * @property {Array<unknown>} [sds]
 * @property {Record<string, unknown>} [tag_probs]
 */

/**
 * @typedef {object} EvaluationReport
 * @property {Span} span
 * @property {EvaluationMetaStruct} metaStruct
 * @property {{ source: string, integration: string }} telemetryTags
 */

/**
 * Returns whether a value is a non-array object.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Parses the backend evaluation response into the tracer's internal contract.
 *
 * @param {unknown} body
 * @returns {EvaluationResponse|undefined}
 */
function parseEvaluationResponse (body) {
  if (!isRecord(body) || !isRecord(body.data) || !isRecord(body.data.attributes)) return

  const attributes = body.data.attributes
  if (typeof attributes.action !== 'string' || attributes.action.length === 0) return

  return {
    action: attributes.action,
    reason: typeof attributes.reason === 'string' ? attributes.reason : undefined,
    tags: Array.isArray(attributes.tags) ? attributes.tags : [],
    sdsFindings: Array.isArray(attributes.sds_findings) ? attributes.sds_findings : [],
    tagProbabilities: isRecord(attributes.tag_probs) ? attributes.tag_probs : {},
    hasTagProbabilities: isRecord(attributes.tag_probs),
    blockingEnabled: attributes.is_blocking_enabled === true,
  }
}

/**
 * Determines whether the current evaluation must abort the guarded operation.
 *
 * @param {boolean} block
 * @param {{ action: string, blockingEnabled: boolean }} evaluation
 * @returns {boolean}
 */
function shouldBlockEvaluation (block, evaluation) {
  return block && evaluation.blockingEnabled && evaluation.action !== ALLOW
}

/**
 * Applies local evaluation policy and creates the result returned to the caller.
 *
 * @param {EvaluationResponse} evaluation
 * @param {boolean} block
 * @returns {EvaluationOutcome}
 */
function createEvaluationOutcome (evaluation, block) {
  return {
    result: {
      action: evaluation.action,
      reason: evaluation.reason,
      tags: evaluation.tags,
      tagProbabilities: evaluation.tagProbabilities,
      sds: evaluation.sdsFindings,
    },
    shouldBlock: shouldBlockEvaluation(block, evaluation),
    hasTagProbabilities: evaluation.hasTagProbabilities,
  }
}

const aiguardMetrics = telemetryMetrics.manager.namespace('ai_guard')

// Tags from the service entry span that must be mirrored onto every AI Guard span
// so anomaly detection pipelines can process each span independently.
const SERVICE_ENTRY_TAG_MAPPINGS = [
  [HTTP_USERAGENT, TAGS.HTTP_USERAGENT_TAG_KEY],
  [HTTP_CLIENT_IP, TAGS.HTTP_CLIENT_IP_TAG_KEY],
  [NETWORK_CLIENT_IP, TAGS.NETWORK_CLIENT_IP_TAG_KEY],
  [USER_ID, TAGS.USR_ID_TAG_KEY],
  [USER_SESSION_ID, TAGS.USR_SESSION_ID_TAG_KEY],
]

class EvaluationReporter {
  #config
  #maxMessagesLength
  #maxContentSize

  /**
   * @param {import('../config/config-base')} config
   */
  constructor (config) {
    this.#config = config
    this.#maxMessagesLength = config.experimental.aiguard.maxMessagesLength
    this.#maxContentSize = config.experimental.aiguard.maxContentSize
  }

  /**
   * Initializes span and trace reporting before the AI Guard request starts.
   *
   * @param {Span} span
   * @param {Message[]} messages
   * @param {{ source: string, integration: string }} options
   * @returns {EvaluationReport}
   */
  start (span, messages, options) {
    const telemetryTags = { source: options.source, integration: options.integration }
    const last = messages.at(-1)
    const target = this.#isToolCall(last) ? 'tool' : 'prompt'
    span.setTag(TAGS.TARGET_TAG_KEY, target)
    if (target === 'tool') {
      const name = this.#getToolName(last, messages)
      if (name) {
        span.setTag(TAGS.TOOL_NAME_TAG_KEY, name)
      }
    }

    const metaStruct = {
      messages: this.#buildMessagesForMetaStruct(messages, telemetryTags),
    }
    span.meta_struct = {
      [TAGS.META_STRUCT_KEY]: metaStruct,
    }

    const rootSpan = span.context()?._trace?.started?.[0]
    if (rootSpan) {
      this.#setRootSpanClientIpTags(rootSpan)
      this.#copyServiceEntryTagsToGuardSpan(span, rootSpan)
      // This must happen before the request so its sampling decision reaches outgoing HTTP spans.
      keepTrace(rootSpan, AI_GUARD)
      rootSpan.setTag(TAGS.EVENT_TAG_KEY, 'true')
    }

    return {
      span,
      metaStruct,
      telemetryTags,
    }
  }

  /**
   * Reports a failed evaluation request.
   *
   * @param {EvaluationReport} report
   * @param {string} errorType
   * @returns {void}
   */
  fail (report, errorType) {
    aiguardMetrics.count(TAGS.TELEMETRY_REQUESTS, { error: true, ...report.telemetryTags }).inc(1)
    aiguardMetrics.count(TAGS.TELEMETRY_ERROR, { type: errorType, ...report.telemetryTags }).inc(1)
  }

  /**
   * Reports a successful evaluation and its local policy outcome.
   *
   * @param {EvaluationReport} report
   * @param {EvaluationOutcome} outcome
   * @returns {void}
   */
  finish (report, outcome) {
    const { result, shouldBlock } = outcome

    if (result.tags.length > 0) report.metaStruct.attack_categories = result.tags
    if (result.sds.length > 0) report.metaStruct.sds = result.sds
    if (outcome.hasTagProbabilities) report.metaStruct.tag_probs = result.tagProbabilities

    const requestTelemetryTags = {
      action: result.action,
      error: false,
      block: shouldBlock,
      ...report.telemetryTags,
    }
    aiguardMetrics.count(TAGS.TELEMETRY_REQUESTS, requestTelemetryTags).inc(1)

    report.span.setTag(TAGS.ACTION_TAG_KEY, result.action)
    if (result.reason) {
      report.span.setTag(TAGS.REASON_TAG_KEY, result.reason)
    }
    if (shouldBlock) {
      report.span.setTag(TAGS.BLOCKED_TAG_KEY, 'true')
    }
  }

  /**
   * Returns a safe, size-limited message copy for the span meta-struct.
   *
   * @param {Message[]} messages
   * @param {{ source: string, integration: string }} telemetryTags
   * @returns {Message[]}
   */
  #buildMessagesForMetaStruct (messages, telemetryTags) {
    const size = Math.min(messages.length, this.#maxMessagesLength)
    if (messages.length > size) {
      aiguardMetrics.count(TAGS.TELEMETRY_TRUNCATED, { type: 'messages', ...telemetryTags }).inc(1)
    }
    const result = []
    let contentTruncated = false
    for (let i = messages.length - size; i < messages.length; i++) {
      const message = clone(messages[i])
      if (message.content?.length > this.#maxContentSize) {
        contentTruncated = true
        message.content = message.content.slice(0, this.#maxContentSize)
      }
      result.push(message)
    }
    if (contentTruncated) {
      aiguardMetrics.count(TAGS.TELEMETRY_TRUNCATED, { type: 'content', ...telemetryTags }).inc(1)
    }
    return result
  }

  /**
   * Returns whether a message represents a tool call or tool output.
   *
   * @param {Message} message
   * @returns {boolean}
   */
  #isToolCall (message) {
    return Boolean(message.tool_calls || message.tool_call_id)
  }

  /**
   * Resolves the tool name associated with a tool call or output message.
   *
   * @param {Message} message
   * @param {Message[]} history
   * @returns {string|null}
   */
  #getToolName (message, history) {
    if (message.tool_calls) {
      const names = message.tool_calls.map(tool => tool.function.name)
      return names.length === 0 ? null : names.join(',')
    }

    const id = message.tool_call_id
    for (let i = history.length - 2; i >= 0; i--) {
      const item = history[i]
      if (item.tool_calls) {
        for (const toolCall of item.tool_calls) {
          if (toolCall.id === id) {
            return toolCall.function.name
          }
        }
      }
    }
    return null
  }

  /**
   * Adds missing client IP tags to the service entry span.
   *
   * @param {Span} rootSpan
   * @returns {void}
   */
  #setRootSpanClientIpTags (rootSpan) {
    const currentTags = rootSpan.context().getTags()
    const needsHttpClientIp = !Object.hasOwn(currentTags, HTTP_CLIENT_IP)
    const needsNetworkClientIp = !Object.hasOwn(currentTags, NETWORK_CLIENT_IP)

    if (!needsHttpClientIp && !needsNetworkClientIp) return

    const request = getActiveRequest()
    if (!request) return

    const newTags = {}
    let hasNewTags = false

    if (needsHttpClientIp) {
      const clientIp = extractIp(this.#config, request)
      if (clientIp) {
        newTags[HTTP_CLIENT_IP] = clientIp
        hasNewTags = true
      }
    }

    if (needsNetworkClientIp) {
      const networkClientIp = request.socket?.remoteAddress
      if (networkClientIp) {
        newTags[NETWORK_CLIENT_IP] = networkClientIp
        hasNewTags = true
      }
    }

    if (hasNewTags) {
      rootSpan.addTags(newTags)
    }
  }

  /**
   * Copies service entry tags required by anomaly detection to the AI Guard span.
   *
   * @param {Span} guardSpan
   * @param {Span} rootSpan
   * @returns {void}
   */
  #copyServiceEntryTagsToGuardSpan (guardSpan, rootSpan) {
    const rootTags = rootSpan.context().getTags()
    for (const [sourceTag, destinationTag] of SERVICE_ENTRY_TAG_MAPPINGS) {
      const value = rootTags[sourceTag]
      if (value !== undefined && value !== null) {
        guardSpan.setTag(destinationTag, value)
      }
    }
  }
}

module.exports = {
  createEvaluationOutcome,
  EvaluationReporter,
  parseEvaluationResponse,
  shouldBlockEvaluation,
}
