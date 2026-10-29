'use strict'

const { HTTP_CLIENT_IP, HTTP_USERAGENT, NETWORK_CLIENT_IP, SERVICE_NAME } = require('../../../../ext/tags')
const createRfdc = require('../../../../vendor/dist/rfdc')
const clone = createRfdc({ proto: false, circles: false })
const { USER_ID, USER_SESSION_ID } = require('../appsec/addresses')
const { getActiveRequest } = require('../appsec/store')
const { MAX_META_KEY_LENGTH, MAX_META_VALUE_LENGTH } = require('../encode/tags-processors')
const log = require('../log')
const { keepTrace } = require('../priority_sampler')
const { extractIp } = require('../plugins/util/ip_extractor')
const { AI_GUARD } = require('../standalone/product')
const telemetryMetrics = require('../telemetry/metrics')
const { truncateString } = require('../util')
const { normalizeRedactionReplacements, redactMessages } = require('./redaction')
const TAGS = require('./tags')

const ALLOW = 'ALLOW'

/** @typedef {import('../../../../index').aiguard.ContentPart} ContentPart */
/** @typedef {import('../../../../index').aiguard.Message} Message */
/** @typedef {import('../../../../index').aiguard.RedactionReplacement} RedactionReplacement */
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
 * @property {unknown} redactionReplacements
 */

/**
 * @typedef {object} EvaluationOutcome
 * @property {{ action: string, reason: string|undefined, tags: Array<unknown>,
 *   tagProbabilities: Record<string, unknown>, sds: Array<unknown>, messages: Message[],
 *   redactionReplacements: RedactionReplacement[] }} result
 * @property {boolean} shouldBlock
 * @property {boolean} hasTagProbabilities
 * @property {{ enabled: boolean, applied: boolean, failures: number }} redaction
 */

/**
 * @typedef {object} EvaluationMetaStruct
 * @property {Message[]} [messages]
 * @property {Array<unknown>} [attack_categories]
 * @property {Array<unknown>} [sds]
 * @property {Record<string, unknown>} [tag_probs]
 */

/**
 * @typedef {object} EvaluationReport
 * @property {Span} span
 * @property {Message[]} messages
 * @property {EvaluationMetaStruct} metaStruct
 * @property {{ source: string, integration: string }} telemetryTags
 */

/** @typedef {{ [key: string]: string | number | boolean }} CustomTags */

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
 * Returns whether a value is a plain object, so boxed primitives, typed arrays and class instances
 * cannot leak their indexes or fields as tags.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject (value) {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Returns whether a custom tag entry can be set on the AI Guard span.
 *
 * Only primitive values are accepted because the span flattens nested objects into dotted keys,
 * which could otherwise smuggle reserved ai_guard.* keys in through a non-reserved parent key.
 * Entries above the agent meta limits are dropped rather than truncated. The limits are checked in
 * characters (UTF-16 code units), so the agent may still truncate values with multi-byte characters.
 * A non-string service.name is dropped because the span formatter calls string methods on it when
 * the trace is exported, after this function can catch the error.
 *
 * @param {string} key
 * @param {unknown} value
 */
function isValidCustomTag (key, value) {
  if (key.length === 0 || key.length > MAX_META_KEY_LENGTH) return false
  if (key === TAGS.RESERVED_TAG_KEY || key.startsWith(TAGS.RESERVED_TAG_PREFIX)) return false
  if (key === SERVICE_NAME && typeof value !== 'string') return false

  switch (typeof value) {
    case 'string':
      return value.length <= MAX_META_VALUE_LENGTH
    case 'number':
      return Number.isFinite(value)
    case 'boolean':
      return true
    default:
      return false
  }
}

/**
 * Sets caller-provided tags on the AI Guard span, dropping invalid or reserved entries.
 *
 * Must run after the service entry tags are copied: when the AI Guard span is the trace root, a
 * custom usr.id or http.client_ip would otherwise be copied into the reserved ai_guard.* keys.
 * Must also run before the verdict tags set in finish(): some of them are only set conditionally,
 * and filtering reserved keys here is what keeps a caller value from misreporting the verdict.
 *
 * @param {Span} span
 * @param {unknown} tags
 */
function setCustomTags (span, tags) {
  let keys
  try {
    if (!isPlainObject(tags)) return
    keys = Object.keys(tags)
  } catch (error) {
    log.debug('AIGuard: failed to read custom tags: %s', error?.message)
    return
  }

  for (const key of keys) {
    try {
      const value = tags[key]
      if (isValidCustomTag(key, value)) {
        span.setTag(key, value)
      } else {
        log.debug('AIGuard: dropping invalid custom tag %s', key)
      }
    } catch (error) {
      log.debug('AIGuard: failed to set custom tag %s: %s', key, error?.message)
    }
  }
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
    redactionReplacements: attributes.redaction_replacements,
  }
}

/**
 * Determines whether the current evaluation must abort the guarded operation.
 *
 * @param {boolean} block
 * @param {{ action: string, blockingEnabled: boolean }} evaluation
 */
function shouldBlockEvaluation (block, evaluation) {
  return block && evaluation.blockingEnabled && evaluation.action !== ALLOW
}

/**
 * Applies local evaluation policy and creates the result returned to the caller.
 *
 * @param {Message[]} messages
 * @param {EvaluationResponse} evaluation
 * @param {{ block: boolean, redactionEnabled: boolean }} options
 * @returns {EvaluationOutcome}
 */
function createEvaluationOutcome (messages, evaluation, options) {
  const redaction = options.redactionEnabled
    ? redactMessages(messages, evaluation.redactionReplacements)
    : { messages, redacted: false, failures: 0 }

  return {
    result: {
      action: evaluation.action,
      reason: evaluation.reason,
      tags: evaluation.tags,
      tagProbabilities: evaluation.tagProbabilities,
      sds: evaluation.sdsFindings,
      messages: redaction.messages,
      redactionReplacements: normalizeRedactionReplacements(evaluation.redactionReplacements),
    },
    shouldBlock: shouldBlockEvaluation(options.block, evaluation),
    hasTagProbabilities: evaluation.hasTagProbabilities,
    redaction: {
      enabled: options.redactionEnabled,
      applied: redaction.redacted,
      failures: redaction.failures,
    },
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
  #redactionEnabled

  /**
   * @param {import('../config/config-base')} config
   */
  constructor (config) {
    this.#config = config
    this.#maxMessagesLength = config.aiguard.DD_AI_GUARD_MAX_MESSAGES_LENGTH
    this.#maxContentSize = config.aiguard.DD_AI_GUARD_MAX_CONTENT_SIZE
    this.#redactionEnabled = config.aiguard.DD_AI_GUARD_REDACTION_ENABLED
  }

  /**
   * Initializes span and trace reporting before the AI Guard request starts.
   *
   * @param {Span} span
   * @param {Message[]} messages
   * @param {{ source: string, integration: string, tags?: CustomTags }} options
   * @returns {EvaluationReport}
   */
  start (span, messages, options) {
    const telemetryTags = { source: options.source, integration: options.integration }
    const evaluatedMessages = this.#redactionEnabled ? clone(messages) : messages
    const last = evaluatedMessages.at(-1)
    const target = this.#isToolCall(last) ? 'tool' : 'prompt'
    span.setTag(TAGS.TARGET_TAG_KEY, target)
    if (target === 'tool') {
      const name = this.#getToolName(last, evaluatedMessages)
      if (name) {
        span.setTag(TAGS.TOOL_NAME_TAG_KEY, name)
      }
    }

    const metaStruct = {}
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

    if (options.tags !== undefined) setCustomTags(span, options.tags)

    return {
      span,
      messages: evaluatedMessages,
      metaStruct,
      telemetryTags,
    }
  }

  /**
   * Reports a failed evaluation request.
   *
   * @param {EvaluationReport} report
   * @param {string} errorType
   */
  fail (report, errorType) {
    report.metaStruct.messages = this.#buildMessagesForMetaStruct(report.messages, report.telemetryTags)
    aiguardMetrics.count(TAGS.TELEMETRY_REQUESTS, { error: true, ...report.telemetryTags }).inc(1)
    aiguardMetrics.count(TAGS.TELEMETRY_ERROR, { type: errorType, ...report.telemetryTags }).inc(1)
  }

  /**
   * Reports a successful evaluation and its local policy outcome.
   *
   * @param {EvaluationReport} report
   * @param {EvaluationOutcome} outcome
   */
  finish (report, outcome) {
    const { result, redaction, shouldBlock } = outcome

    if (result.tags.length > 0) report.metaStruct.attack_categories = result.tags
    if (result.sds.length > 0) report.metaStruct.sds = result.sds
    if (outcome.hasTagProbabilities) report.metaStruct.tag_probs = result.tagProbabilities

    if (redaction.enabled) {
      report.span.setTag(TAGS.REDACTED_TAG_KEY, redaction.applied ? 'true' : 'false')
      if (redaction.failures > 0) {
        aiguardMetrics.count(TAGS.TELEMETRY_ERROR, {
          type: TAGS.ERROR_TYPE_REDACTION,
          ...report.telemetryTags,
        }).inc(redaction.failures)
      }
    }

    report.metaStruct.messages = this.#buildMessagesForMetaStruct(result.messages, report.telemetryTags)

    const requestTelemetryTags = redaction.enabled
      ? {
          action: result.action,
          error: false,
          block: shouldBlock,
          redacted: redaction.applied,
          ...report.telemetryTags,
        }
      : {
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
      if (this.#truncateMessageContent(message)) contentTruncated = true
      result.push(message)
    }
    if (contentTruncated) {
      aiguardMetrics.count(TAGS.TELEMETRY_TRUNCATED, { type: 'content', ...telemetryTags }).inc(1)
    }
    return result
  }

  /**
   * Truncates text in a cloned message to one shared content-size limit.
   *
   * @param {{ content?: string|ContentPart[] }} message
   */
  #truncateMessageContent (message) {
    const { content } = message
    if (typeof content === 'string') {
      if (content.length <= this.#maxContentSize) return false

      message.content = truncateString(content, this.#maxContentSize)
      return true
    }

    if (!Array.isArray(content)) return false

    let remainingContentSize = this.#maxContentSize
    let truncated = false
    for (const part of content) {
      const text = part?.text
      if (typeof text !== 'string') continue

      if (text.length > remainingContentSize) {
        part.text = truncateString(text, remainingContentSize)
        truncated = true
        remainingContentSize = 0
      } else {
        remainingContentSize -= text.length
      }
    }
    return truncated
  }

  /**
   * Returns whether a message represents a tool call or tool output.
   *
   * @param {Message} message
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
