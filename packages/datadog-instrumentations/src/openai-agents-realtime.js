'use strict'

const dc = require('dc-polyfill')

const { getValueFromEnvSources } = require('../../dd-trace/src/config/helper')
const log = require('../../dd-trace/src/log')
const shimmer = require('../../datadog-shimmer')
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
      if (name === 'connection_change' && event === 'disconnected') {
        // SDK listeners can reconnect before the old socket's close callback runs.
        // Keep that callback's record alive so it still classifies the close code.
        const record = records.get(this)
        if (record) record.detached = true
      }
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
  try {
    const options = ctx.arguments?.[0] || {}
    if (options.url) ctx.realtimeDefaultUrl = connectionOptions(options.url)
    if (!turnChannel.start.hasSubscribers) return
    listen(ctx)
    const transport = ctx.self
    const previous = records.get(transport)
    if (previous && !previous.closed && !previous.detached) return
    // Match the SDK's precedence. An explicit URL wins even when callId is also supplied.
    const effective = ctx.realtimeDefaultUrl ?? (options.callId
      ? connectionOptions('wss://api.openai.com/v1/realtime?call_id=' + options.callId)
      : defaultUrls.get(transport) || connectionOptions('wss://api.openai.com/v1/realtime'))
    const retrieveAudio = getValueFromEnvSources('DD_OPENAI_REALTIME_SIDEBAND_AUDIO_RETRIEVAL_ENABLED') !== false
    const connection = createSession({
      model: options.model ?? transport.currentModel,
      basePath: effective.basePath,
      sessionId: effective.callId,
      serverPlayback: effective.callId !== undefined,
      requestItem: retrieveAudio
        ? (itemId, eventId) => {
            if (transport.status === 'connected') {
              transport.sendEvent({ type: 'conversation.item.retrieve', item_id: itemId, event_id: eventId })
            }
          }
        : undefined,
    })
    const record = {
      session: connection.session,
      closed: false,
      detached: false,
      finalize: failed => {
        if (record.closed) return
        record.closed = true
        connection.finalize(failed)
      },
    }
    records.set(transport, record)
    ctx.realtimeConnection = record
  } catch (error) {
    log.debug('Error starting Agents realtime instrumentation: %s', error?.message)
  }
}

/** @param {object} ctx */
function connected (ctx) {
  try {
    if (ctx.realtimeConnectFailed) return
    // The SDK retains successful URL overrides even while tracing is disabled.
    if (ctx.realtimeDefaultUrl) defaultUrls.set(ctx.self, ctx.realtimeDefaultUrl)
    const record = ctx.realtimeConnection
    if (record && !record.closed) {
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

/** @param {{ self: object, realtimeConnection?: { finalize: (failed?: boolean) => void } }} ctx */
function closing (ctx) {
  ctx.realtimeConnection = records.get(ctx.self)
}

/** @param {object} ctx */
function closed (ctx) {
  ctx.realtimeConnection?.finalize(false)
}

/** @param {object} ctx */
function failed (ctx) {
  ctx.realtimeConnectFailed = true
  ctx.realtimeConnection?.finalize(true)
}

if (realtimeEnabled()) {
  dc.tracingChannel('orchestrion:@openai/agents-realtime:constructor').end.subscribe(listen)
  const connection = dc.tracingChannel('orchestrion:@openai/agents-realtime:connect')
  connection.start.subscribe(connect)
  connection.asyncEnd.subscribe(connected)
  connection.error.subscribe(failed)
  dc.tracingChannel('orchestrion:@openai/agents-realtime:send').end.subscribe(sent)
  const close = dc.tracingChannel('orchestrion:@openai/agents-realtime:close')
  close.start.subscribe(closing)
  close.end.subscribe(closed)
}
