'use strict'

const dc = require('dc-polyfill')

const log = require('../../dd-trace/src/log')
const shimmer = require('../../datadog-shimmer')
const { addHook, getHooks } = require('./helpers/instrument')
const { attachSocketClose, createSession, realtimeEnabled } = require('./openai-realtime')

const turnChannel = dc.tracingChannel('apm:openai:realtime:turn')
const records = new WeakMap()
const listening = new WeakSet()
const defaultUrls = new WeakMap()

/** @param {string | URL} value */
function connectionOptions (value) {
  const url = new URL(value)
  return {
    basePath: url.origin + url.pathname,
    callId: url.searchParams.get('call_id') || undefined,
  }
}

/** @param {object} ctx */
function listen (ctx) {
  const transport = ctx.self
  if (!transport || listening.has(transport)) return
  try {
    const url = ctx.arguments?.[0]?.url
    if (url) defaultUrls.set(transport, connectionOptions(url))
    // emit is inherited from agents-core's shared delegate. Orchestrion cannot skip
    // its body, so wrap this instance to filter only tracer-owned request failures.
    // Raw events still reach the session before any SDK/application listeners.
    shimmer.wrap(transport, 'emit', emit => function (name, event) {
      if (name === '*' || name === 'error') {
        const record = records.get(this)
        if (record) {
          const providerEvent = name === '*' ? event : event?.error
          if (name === '*' && !record.closed) record.session.onServerEvent(event, Date.now())
          if (record.session.isRetrievalError(providerEvent)) return false
        }
      }
      return emit.apply(this, arguments)
    })
    listening.add(transport)
  } catch (error) {
    log.debug('Error observing Agents realtime events: %s', error?.message)
  }
}

/** @param {object} ctx */
function connect (ctx) {
  if (!turnChannel.start.hasSubscribers) return
  try {
    listen(ctx)
    const transport = ctx.self
    const options = ctx.arguments?.[0] || {}
    const previous = records.get(transport)
    if (previous && !previous.closed) return
    // Match the SDK's precedence. An explicit URL wins even when callId is also supplied.
    const effective = options.url
      ? connectionOptions(options.url)
      : options.callId
        ? connectionOptions('wss://api.openai.com/v1/realtime?call_id=' + options.callId)
        : defaultUrls.get(transport) || connectionOptions('wss://api.openai.com/v1/realtime')
    const connection = createSession({
      model: options.model ?? transport.currentModel,
      basePath: effective.basePath,
      sessionId: effective.callId,
      serverPlayback: effective.callId !== undefined,
      requestItem: (itemId, eventId) => {
        if (transport.status === 'connected') {
          transport.sendEvent({ type: 'conversation.item.retrieve', item_id: itemId, event_id: eventId })
        }
      },
    })
    const record = {
      session: connection.session,
      closed: false,
      finalize: failed => {
        if (record.closed) return
        record.closed = true
        connection.finalize(failed)
      },
    }
    records.set(transport, record)
    ctx.realtimeConnection = record
    if (options.url) ctx.realtimeDefaultUrl = effective
  } catch (error) {
    log.debug('Error starting Agents realtime instrumentation: %s', error?.message)
  }
}

/** @param {object} ctx */
function connected (ctx) {
  try {
    const record = ctx.realtimeConnection
    if (record && !record.closed) {
      // A rejected connect restores the SDK's previous default, so only remember successful changes.
      if (ctx.realtimeDefaultUrl) defaultUrls.set(ctx.self, ctx.realtimeDefaultUrl)
      attachSocketClose({ socket: ctx.self.connectionState?.websocket }, record.finalize)
    }
  } catch (error) {
    log.debug('Error observing Agents realtime connection: %s', error?.message)
  }
}

/** @param {object} ctx */
function sent (ctx) {
  const record = records.get(ctx.self)
  if (record && !record.closed && !ctx.error) record.session.onClientEvent(ctx.arguments[0], Date.now())
}

/** @param {object} ctx */
function closed (ctx) {
  records.get(ctx.self)?.finalize(false)
}

/** @param {object} ctx */
function failed (ctx) {
  ctx.realtimeConnection?.finalize(true)
}

if (realtimeEnabled()) {
  for (const hook of getHooks('@openai/agents-realtime').values()) addHook(hook, exports => exports)
  dc.tracingChannel('orchestrion:@openai/agents-realtime:constructor').end.subscribe(listen)
  const connection = dc.tracingChannel('orchestrion:@openai/agents-realtime:connect')
  connection.start.subscribe(connect)
  connection.asyncEnd.subscribe(connected)
  connection.error.subscribe(failed)
  dc.tracingChannel('orchestrion:@openai/agents-realtime:send').end.subscribe(sent)
  dc.tracingChannel('orchestrion:@openai/agents-realtime:close').end.subscribe(closed)
}
