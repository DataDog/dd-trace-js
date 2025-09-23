'use strict'

const NoopAIGuard = require('./noop')
const executeRequest = require('./client')
const {
  AI_GUARD_TARGET_TAG_KEY,
  AI_GUARD_REASON_TAG_KEY,
  AI_GUARD_ACTION_TAG_KEY,
  AI_GUARD_BLOCKED_TAG_KEY,
  AI_GUARD_META_STRUCT_KEY,
  AI_GUARD_TOOL_NAME_TAG_KEY
} = require('./tags')
const log = require('../../log')

class AIGuardAbortError extends Error {
  constructor (reason) {
    super(reason)
    this.name = 'AIGuardAbortError'
    this.reason = reason
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
  constructor (tracer, config) {
    super(tracer)
    if (!config.aiguard.endpoint) {
      const message = 'AIGuard: missing endpoint, use env DD_AI_GUARD_ENDPOINT'
      log.error(message)
      throw new Error(message)
    }
    if (!config.apiKey) {
      const message = 'AIGuard: missing api key, use env DD_API_KEY'
      log.error(message)
      throw new Error(message)
    }
    if (!config.appKey) {
      const message = 'AIGuard: missing app key, use env DD_APP_KEY'
      log.error(message)
      throw new Error(message)
    }
    if (config.protocolVersion !== '0.4') {
      const message = 'AIGuard: requires protocol version 0.4'
      log.error(message)
      throw new Error(message)
    }
    this._evaluateUrl = `${config.aiguard.endpoint}/evaluate`
    this._headers = {
      'DD-API-KEY': config.apiKey,
      'DD-APPLICATION-KEY': config.appKey,
    }
    this._meta = { service: config.service, env: config.env }
  }

  _truncate (messages) {
    // TODO truncate the messages and return a safe copy to be used in the meta-struct
    return [...messages]
  }

  _isToolCall (message) {
    if (message.tool_calls) {
      return true
    }
    return message.role && message.role === 'tool'
  }

  async evaluate (messages, opts) {
    const { block = false } = opts ?? {}
    return await this._tracer.trace('ai_guard', {}, async (span) => {
      const last = messages[messages.length - 1]
      const target = this._isToolCall(last) ? 'tool' : 'prompt'
      span.setTag(AI_GUARD_TARGET_TAG_KEY, target)
      if (target === 'tool') {
        const names = last.tool_calls.map((tool) => tool.function.name)
        span.setTag(AI_GUARD_TOOL_NAME_TAG_KEY, names.join(', '))
      }
      span.meta_struct = {
        [AI_GUARD_META_STRUCT_KEY]: {
          messages: this._truncate(messages)
        }
      }
      let response
      try {
        const payload = {
          data: {
            attributes: {
              messages,
              meta: this._meta,
            }
          }
        }
        response = await executeRequest(this._evaluateUrl, this._headers, payload)
      } catch (e) {
        log.debug('AI Guard API call failed', e)
        throw new AIGuardClientError('Unexpected error calling AI Guard service', { cause: e })
      }
      if (response.status !== 200) {
        log.debug(`AI Guard API call failed: ${JSON.stringify(response)}`)
        throw new AIGuardClientError(
          `AI Guard service call failed, status ${response.status}`,
          { errors: response.body?.errors })
      }
      let action, reason, shouldBlock
      try {
        const attr = response.body.data.attributes
        action = attr.action
        reason = attr.reason
        if (!action || !reason) {
          throw new Error('Action and/or reason missing from response')
        }
        shouldBlock = block && (attr.is_blocking_enabled ?? false) && attr.action !== 'ALLOW'
      } catch (e) {
        throw new AIGuardClientError(`AI Guard service returned unexpected response : ${response.body}`, { cause: e })
      }
      span.setTag(AI_GUARD_ACTION_TAG_KEY, action)
      span.setTag(AI_GUARD_REASON_TAG_KEY, reason)
      if (shouldBlock) {
        span.setTag(AI_GUARD_BLOCKED_TAG_KEY, 'true')
        throw new AIGuardAbortError(reason)
      }
      return { action, reason }
    })
  }
}

module.exports = AIGuard
