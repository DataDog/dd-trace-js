'use strict'

const dc = require('dc-polyfill')

const log = require('../../dd-trace/src/log')
const { addHook, getHooks } = require('./helpers/instrument')
const { attachSocketClose, createSession, realtimeEnabled } = require('./openai-realtime')

const turnChannel = dc.tracingChannel('apm:openai:realtime:turn')
const records = new WeakMap()
const listening = new WeakSet()

/** @param {object} ctx */
function listen (ctx) {
  const transport = ctx.self
  if (!transport || listening.has(transport)) return
  try {
    // The constructor hook installs this before the SDK/session's application listeners.
    // '*' preserves fields that the SDK's normalized named events can discard.
    transport.on('*', event => {
      const record = records.get(transport)
      if (record && !record.closed) record.session.onServerEvent(event, Date.now())
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
    const url = new URL(options.url || 'https://api.openai.com/v1/realtime')
    const callId = options.callId || url.searchParams.get('call_id') || undefined
    const connection = createSession({
      model: options.model || transport.currentModel,
      basePath: url.origin + url.pathname,
      sessionId: callId,
      serverPlayback: callId !== undefined,
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
  } catch (error) {
    log.debug('Error starting Agents realtime instrumentation: %s', error?.message)
  }
}

/** @param {object} ctx */
function connected (ctx) {
  try {
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
