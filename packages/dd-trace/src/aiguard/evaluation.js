'use strict'

const {
  ERROR,
  HTTP_CLIENT_IP,
  HTTP_USERAGENT,
  MANUAL_DROP,
  MANUAL_KEEP,
  NETWORK_CLIENT_IP,
  RESOURCE_NAME,
  SAMPLING_PRIORITY,
  SERVICE_NAME,
  SPAN_KIND,
  SPAN_TYPE,
} = require('../../../../ext/tags')
const createRfdc = require('../../../../vendor/dist/rfdc')
const clone = createRfdc({ proto: false, circles: false })
const { USER_ID, USER_SESSION_ID } = require('../appsec/addresses')
const { getActiveRequest } = require('../appsec/store')
const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE, PROCESS_ID, SAMPLING_PRIORITY_KEY } = require('../constants')
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
 * @property {unknown} extraTags
 * @property {unknown} extraMetastruct
 */

/**
 * @typedef {object} EvaluationOutcome
 * @property {{ action: string, reason: string|undefined, tags: Array<unknown>,
 *   tagProbabilities: Record<string, unknown>, sds: Array<unknown>, messages: Message[],
 *   redactionReplacements: RedactionReplacement[] }} result
 * @property {boolean} shouldBlock
 * @property {boolean} hasTagProbabilities
 * @property {{ enabled: boolean, applied: boolean, failures: number }} redaction
 * @property {unknown} extraTags
 * @property {unknown} extraMetastruct
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
    redactionReplacements: attributes.redaction_replacements,
    // Validated when applied to the span: a malformed value must not turn into a bad_response.
    extraTags: attributes.extra_tags,
    extraMetastruct: attributes.extra_metastruct,
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
    extraTags: evaluation.extraTags,
    extraMetastruct: evaluation.extraMetastruct,
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

// Backend extra tags never override what the tracer computes itself, nor keys that control the
// span or its trace (sampling, service, resource, error state). Internal _dd keys are covered by
// isReservedExtraTag instead of being listed here.
const RESERVED_EXTRA_TAGS = new Set([
  TAGS.ACTION_TAG_KEY,
  TAGS.REASON_TAG_KEY,
  TAGS.TARGET_TAG_KEY,
  TAGS.TOOL_NAME_TAG_KEY,
  TAGS.BLOCKED_TAG_KEY,
  TAGS.REDACTED_TAG_KEY,
  TAGS.EVENT_TAG_KEY,
  ...SERVICE_ENTRY_TAG_MAPPINGS.map(([, destinationTag]) => destinationTag),
  MANUAL_KEEP,
  MANUAL_DROP,
  SAMPLING_PRIORITY,
  SERVICE_NAME,
  RESOURCE_NAME,
  SPAN_TYPE,
  SPAN_KIND,
  ERROR,
  ERROR_TYPE,
  ERROR_MESSAGE,
  ERROR_STACK,
  SAMPLING_PRIORITY_KEY,
  PROCESS_ID,
  'analytics.event',
  'language',
  'runtime-id',
  'service.version',
  'version',
  'env',
])

/**
 * Returns whether a backend extra tag key must not be set on the span.
 *
 * @param {string} key
 */
function isReservedExtraTag (key) {
  // _dd is the tracer's internal namespace (_dd.*, _dd1.*): the span formatter writes sampling,
  // top-level and propagation keys there and a span tag with the same key would overwrite them.
  // This is not an AI Guard namespace filter; the backend owns ai_guard.* keys.
  return key.startsWith('_dd') || RESERVED_EXTRA_TAGS.has(key)
}

const RESERVED_EXTRA_META_STRUCT_KEYS = new Set(['messages', 'attack_categories', 'sds', 'tag_probs'])

/**
 * Returns whether a backend extra field is a list of entries, logging when it is malformed.
 *
 * @param {string} field
 * @param {unknown} entries
 * @returns {entries is unknown[]}
 */
function isEntryList (field, entries) {
  if (entries === undefined) return false
  if (Array.isArray(entries)) return true

  log.debug('AI Guard: ignoring %s of type %s', field, entries === null ? 'null' : typeof entries)
  return false
}

/**
 * Returns the key of a backend extra field entry, or undefined when the entry is malformed.
 *
 * @param {string} field
 * @param {unknown} entry
 */
function getEntryKey (field, entry) {
  const key = isRecord(entry) ? entry.key : undefined
  // A __proto__ key cannot be stored as an own entry on the span tags or the meta-struct.
  const isValid = typeof key === 'string' && key.length > 0 && key !== '__proto__'
  if (!isValid) log.debug('AI Guard: ignoring malformed %s entry', field)
  return isValid ? key : undefined
}

/**
 * Copies backend-provided extra_tags to the span and extra_metastruct to the AI Guard meta-struct.
 * Both are lists of key/value entries because their dotted keys are not valid JSON:API member
 * names. Keys are used verbatim, a repeated key keeps its last value, and malformed input is
 * skipped without throwing.
 *
 * @param {Span} span
 * @param {EvaluationMetaStruct} metaStruct
 * @param {unknown} extraTags
 * @param {unknown} extraMetastruct
 */
function applyExtraSpanData (span, metaStruct, extraTags, extraMetastruct) {
  // The client decodes the payload with JSON.parse, so values are JSON types.
  if (isEntryList('extra_tags', extraTags)) {
    for (const entry of extraTags) {
      const key = getEntryKey('extra_tags', entry)
      if (key === undefined) continue

      const { value } = /** @type {{ value?: unknown }} */ (entry)
      if (typeof value !== 'string') {
        log.debug('AI Guard: ignoring extra_tags entry %s with non-string value', key)
      } else if (isReservedExtraTag(key)) {
        log.debug('AI Guard: ignoring reserved extra tag %s', key)
      } else {
        span.setTag(key, value)
      }
    }
  }

  if (isEntryList('extra_metastruct', extraMetastruct)) {
    for (const entry of extraMetastruct) {
      const key = getEntryKey('extra_metastruct', entry)
      if (key === undefined) continue

      const { value } = /** @type {{ value?: unknown }} */ (entry)
      if (value === undefined || value === null) {
        log.debug('AI Guard: ignoring extra_metastruct entry %s with null value', key)
      } else if (RESERVED_EXTRA_META_STRUCT_KEYS.has(key)) {
        log.debug('AI Guard: ignoring reserved extra_metastruct key %s', key)
      } else {
        metaStruct[key] = value
      }
    }
  }
}

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
   * @param {{ source: string, integration: string }} options
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
    applyExtraSpanData(report.span, report.metaStruct, outcome.extraTags, outcome.extraMetastruct)

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
