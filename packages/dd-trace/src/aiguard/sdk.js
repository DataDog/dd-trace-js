'use strict'

const rfdc = require('../../../../vendor/dist/rfdc')({ proto: false, circles: false })
const { HTTP_CLIENT_IP, NETWORK_CLIENT_IP } = require('../../../../ext/tags')
const { getActiveRequest } = require('../appsec/store')
const log = require('../log')
const { extractIp } = require('../plugins/util/ip_extractor')
const telemetryMetrics = require('../telemetry/metrics')
const tracerVersion = require('../../../../package.json').version
const { keepTrace } = require('../priority_sampler')
const { AI_GUARD } = require('../standalone/product')
const NoopAIGuard = require('./noop')
const executeRequest = require('./client')
const TAGS = require('./tags')

const aiguardMetrics = telemetryMetrics.manager.namespace('ai_guard')

const ALLOW = 'ALLOW'

/**
 * Reports a telemetry error
 *
 * @param {string} errorType - The error type constant (client_error, bad_status, bad_response)
 * @param {{ source: string, integration: string }} telemetryTags - Source and integration tags
 */
function reportTelemetryError (errorType, telemetryTags) {
  aiguardMetrics.count(TAGS.TELEMETRY_REQUESTS, { error: true, ...telemetryTags }).inc(1)
  aiguardMetrics.count(TAGS.TELEMETRY_ERROR, { type: errorType, ...telemetryTags }).inc(1)
}

class AIGuardAbortError extends Error {
  constructor (reason, tags, tagProbs, sds) {
    super(reason)
    this.name = 'AIGuardAbortError'
    this.reason = reason
    this.tags = tags
    this.tagProbabilities = tagProbs
    this.sds = sds || []
  }
}

class AIGuardClientError extends Error {
  constructor (message, opts = {}) {
    super(message)
    this.name = 'AIGuardClientError'
    if (opts.errors) {
      this.errors = opts.errors
    }
    if (opts.cause) {
      this.cause = opts.cause
    }
  }
}

class AIGuard extends NoopAIGuard {
  #initialized
  #tracer
  #headers
  #evaluateUrl
  #timeout
  #maxMessagesLength
  #maxContentSize
  #meta
  #config

  /**
   * @param {import('../tracer')} tracer - Tracer instance
   * @param {import('../config/config-base')} config - Tracer configuration
   */
  constructor (tracer, config) {
    super()

    if (!config.apiKey || !config.appKey) {
      log.error('AIGuard: missing api and/or app keys, use env DD_API_KEY and DD_APP_KEY')
      this.#initialized = false
      return
    }
    this.#tracer = tracer
    this.#headers = {
      'DD-API-KEY': config.apiKey,
      'DD-APPLICATION-KEY': config.appKey,
      'DD-AI-GUARD-VERSION': tracerVersion,
      'DD-AI-GUARD-SOURCE': 'SDK',
      'DD-AI-GUARD-LANGUAGE': 'nodejs',
    }
    const endpoint = config.experimental.aiguard.endpoint || `https://app.${config.site}/api/v2/ai-guard`
    this.#evaluateUrl = `${endpoint}/evaluate`
    this.#timeout = config.experimental.aiguard.timeout
    this.#maxMessagesLength = config.experimental.aiguard.maxMessagesLength
    this.#maxContentSize = config.experimental.aiguard.maxContentSize
    this.#meta = { service: config.service, env: config.env }
    this.#config = config
    this.#initialized = true
  }

  /**
   * Returns a safe copy of the messages to be serialized into the meta struct.
   *
   * - Clones each message so callers cannot mutate the data set in the meta struct.
   * - Truncates the list of messages and `content` fields emitting metrics accordingly.
   */
  #buildMessagesForMetaStruct (messages, telemetryTags) {
    const size = Math.min(messages.length, this.#maxMessagesLength)
    if (messages.length > size) {
      aiguardMetrics.count(TAGS.TELEMETRY_TRUNCATED, { type: 'messages', ...telemetryTags }).inc(1)
    }
    const result = []
    let contentTruncated = false
    for (let i = messages.length - size; i < messages.length; i++) {
      const message = rfdc(messages[i])
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

  #isToolCall (message) {
    return message.tool_calls || message.tool_call_id
  }

  #getToolName (message, history) {
    // 1. assistant message with tool calls
    if (message.tool_calls) {
      const names = message.tool_calls.map((tool) => tool.function.name)
      return names.length === 0 ? null : names.join(',')
    }
    // 2. assistant message with tool output (search the linked tool call in reverse order)
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

  #setRootSpanClientIpTags (rootSpan) {
    if (!rootSpan) return

    const currentTags = rootSpan.context()._tags
    const needsHttpClientIp = !Object.hasOwn(currentTags, HTTP_CLIENT_IP)
    const needsNetworkClientIp = !Object.hasOwn(currentTags, NETWORK_CLIENT_IP)

    if (!needsHttpClientIp && !needsNetworkClientIp) return

    const req = getActiveRequest()

    if (!req) return

    const newTags = {}

    if (needsHttpClientIp) {
      const clientIp = extractIp(this.#config, req)

      if (clientIp) {
        newTags[HTTP_CLIENT_IP] = clientIp
      }
    }

    if (needsNetworkClientIp) {
      const networkClientIp = req.socket?.remoteAddress

      if (networkClientIp) {
        newTags[NETWORK_CLIENT_IP] = networkClientIp
      }
    }

    if (Object.keys(newTags).length > 0) {
      rootSpan.addTags(newTags)
    }
  }

  evaluate (messages, opts) {
    if (!this.#initialized) {
      return super.evaluate(messages, opts)
    }
    const { block = true, source = TAGS.SOURCE_SDK, integration = TAGS.INTEGRATION_NONE } = opts ?? {}
    const telemetryTags = { source, integration }
    return this.#tracer.trace(TAGS.RESOURCE, {}, async (span) => {
      const last = messages[messages.length - 1]
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
        // keepTrace must be called before executeRequest so the sampling decision
        // is propagated correctly to outgoing HTTP client calls.
        keepTrace(rootSpan, AI_GUARD)
        rootSpan.setTag(TAGS.EVENT_TAG_KEY, 'true')
      }
      let response
      try {
        const payload = {
          data: {
            attributes: {
              messages,
              meta: this.#meta,
            },
          },
        }
        response = await executeRequest(
          payload,
          { url: this.#evaluateUrl, headers: this.#headers, timeout: this.#timeout })
      } catch (e) {
        reportTelemetryError(TAGS.ERROR_TYPE_CLIENT, telemetryTags)
        throw new AIGuardClientError(`Unexpected error calling AI Guard service: ${e.message}`, { cause: e })
      }
      if (response.status !== 200) {
        reportTelemetryError(TAGS.ERROR_TYPE_STATUS, telemetryTags)
        throw new AIGuardClientError(
          `AI Guard service call failed, status ${response.status}`,
          { errors: response.body?.errors })
      }
      const attr = response.body?.data?.attributes
      if (!attr?.action) {
        reportTelemetryError(TAGS.ERROR_TYPE_RESPONSE, telemetryTags)
        throw new AIGuardClientError(`AI Guard service returned unexpected response : ${response.body}`)
      }
      const action = attr.action
      const reason = attr.reason
      const tags = attr.tags ?? []
      if (tags.length > 0) {
        metaStruct.attack_categories = tags
      }
      const sdsFindings = attr.sds_findings ?? []
      if (sdsFindings.length > 0) {
        metaStruct.sds = sdsFindings
      }
      const tagProbabilities = attr.tag_probs ?? {}
      if (attr.tag_probs) {
        metaStruct.tag_probs = tagProbabilities
      }
      const blockingEnabled = attr.is_blocking_enabled ?? false
      const shouldBlock = block && blockingEnabled && action !== ALLOW
      aiguardMetrics.count(TAGS.TELEMETRY_REQUESTS, {
        action,
        error: false,
        block: shouldBlock,
        ...telemetryTags,
      }).inc(1)
      span.setTag(TAGS.ACTION_TAG_KEY, action)
      if (reason) {
        span.setTag(TAGS.REASON_TAG_KEY, reason)
      }
      if (shouldBlock) {
        span.setTag(TAGS.BLOCKED_TAG_KEY, 'true')
        throw new AIGuardAbortError(reason, tags, tagProbabilities, sdsFindings)
      }
      return { action, reason, tags, tagProbabilities, sds: sdsFindings }
    })
  }
}

module.exports = AIGuard
