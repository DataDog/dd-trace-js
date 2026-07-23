'use strict'

const { storage } = require('../../../datadog-core')
const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE } = require('../constants')
const { isError } = require('../util')
const { FlushCoordinator } = require('./flush-coordinator')
const channels = require('./channels')

const legacyStorage = storage('legacy')

class ServerlessInvocationProcessor {
  /**
   * @param {object} tracer Internal tracer instance.
   * @param {object} [options]
   * @param {FlushCoordinator} [options.flushCoordinator] Coordinator used to drain trace data.
   */
  constructor (tracer, options = {}) {
    this._tracer = tracer
    this._flushCoordinator = options.flushCoordinator || new FlushCoordinator(tracer)
    this._invocations = new WeakMap()
    this._enabled = false

    this._onStart = this._onStart.bind(this)
    this._onFinish = this._onFinish.bind(this)
    this._onError = this._onError.bind(this)
    this._onTimeout = this._onTimeout.bind(this)
  }

  /**
   * Subscribe to normalized serverless invocation events.
   *
   * @returns {void}
   */
  enable () {
    if (this._enabled) return
    this._enabled = true
    channels.invocationStart.bindStore(legacyStorage, this._onStart)
    channels.invocationFinish.subscribe(this._onFinish)
    channels.invocationError.subscribe(this._onError)
    channels.invocationTimeout.subscribe(this._onTimeout)
  }

  /**
   * Unsubscribe from normalized serverless invocation events.
   *
   * @returns {void}
   */
  disable () {
    if (!this._enabled) return
    this._enabled = false
    channels.invocationStart.unbindStore(legacyStorage)
    channels.invocationFinish.unsubscribe(this._onFinish)
    channels.invocationError.unsubscribe(this._onError)
    channels.invocationTimeout.unsubscribe(this._onTimeout)
    this._invocations = new WeakMap()
  }

  /**
   * Start the root invocation span and bind it into legacy storage for user code.
   *
   * @param {object} event Normalized serverless invocation event.
   * @returns {object|undefined} Store to enter while the platform invokes user code.
   */
  _onStart (event) {
    if (!isInvocationEvent(event) || !isObjectToken(event.token)) return legacyStorage.getStore()

    const token = event.token
    const activeInvocation = this._invocations.get(token)
    if (activeInvocation) return activeInvocation.currentStore

    const data = event.data || {}
    const source = event.source || {}
    const parentStore = legacyStorage.getStore()
    const span = this._tracer.startSpan(getOperationName(event), {
      childOf: getParentContext(this._tracer, event),
      startTime: data.startTime,
      tags: getSpanTags(event),
      integrationName: source.integration || source.platform || 'serverless',
    })
    const currentStore = { ...parentStore, span }

    event.context = {
      ...event.context,
      parentStore,
      currentStore,
      span,
    }

    const state = {
      span,
      source,
      currentStore,
      deadlineMs: data.deadlineMs,
    }
    this._invocations.set(token, state)
    event.context.operationState = state

    return currentStore
  }

  /**
   * Finish a successful invocation.
   *
   * @param {object} event Normalized serverless invocation event.
   * @returns {void}
   */
  _onFinish (event) {
    this._complete(event, 'finish')
  }

  /**
   * Finish an invocation that failed with an error.
   *
   * @param {object} event Normalized serverless invocation event.
   * @returns {void}
   */
  _onError (event) {
    this._complete(event, 'error', getEventError(event))
  }

  /**
   * Mark an invocation as timed out, finish unfinished work, and flush.
   *
   * @param {object} event Normalized serverless invocation event.
   * @returns {void}
   */
  _onTimeout (event) {
    const error = getEventError(event) || new Error('Serverless invocation timed out')
    this._complete(event, 'timeout', error)
  }

  /**
   * Finish a root invocation span once and hand off to the flush coordinator.
   *
   * @param {object} event Normalized serverless invocation event.
   * @param {string} reason Completion reason.
   * @param {unknown} [error] Optional invocation error.
   * @returns {void}
   */
  _complete (event, reason, error) {
    const state = this._invocations.get(event?.token)
    if (!state) return

    this._invocations.delete(event.token)

    if (error) {
      addError(state.span, error)
    }

    state.span.finish(event?.data?.finishTime)

    this._flushCoordinator.flush({
      reason,
      token: event.token,
      source: event.source || state.source,
      deadlineMs: event?.data?.deadlineMs ?? state.deadlineMs,
    }, getDoneCallback(event))
  }
}

function isInvocationEvent (event) {
  return event?.kind === 'serverless' && event.operation === 'invocation'
}

function isObjectToken (token) {
  return (typeof token === 'object' && token !== null) || typeof token === 'function'
}

function getParentContext (tracer, event) {
  const data = event.data || {}
  if (data.childOf !== undefined) return data.childOf
  const carrier = data.carrier || data.headers
  return carrier && typeof tracer.extract === 'function'
    ? tracer.extract('text_map', carrier) || null
    : null
}

function getOperationName (event) {
  const data = event.data || {}
  return data.operationName || `${event.source?.platform || 'serverless'}.invocation`
}

function getSpanTags (event) {
  const data = event.data || {}
  const source = event.source || {}
  const tags = {
    component: source.integration || source.platform || 'serverless',
    'span.kind': 'server',
    'span.type': 'serverless',
    'resource.name': data.resourceName || data.handlerName || data.functionName,
    ...data.tags,
  }

  if (source.platform !== undefined) tags['serverless.platform'] = source.platform
  if (data.functionName !== undefined) tags['serverless.function.name'] = data.functionName
  if (data.handlerName !== undefined) tags['serverless.handler'] = data.handlerName
  if (data.triggerType !== undefined) tags['serverless.trigger'] = data.triggerType
  if (data.route !== undefined) tags['http.route'] = data.route

  return tags
}

function getEventError (event) {
  return event?.error || event?.data?.error
}

function addError (span, error) {
  if (isError(error)) {
    span.addTags({
      [ERROR_TYPE]: error.name,
      [ERROR_MESSAGE]: error.message,
      [ERROR_STACK]: error.stack,
    })
    return
  }

  span.setTag('error', error)
}

function getDoneCallback (event) {
  return event?.done || event?.context?.done
}

module.exports = {
  ServerlessInvocationProcessor,
}
