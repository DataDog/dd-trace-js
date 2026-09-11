'use strict'

const dc = require('dc-polyfill')

const { getEnvironmentVariable } = require('../../../dd-trace/src/config/helper')
const log = require('../../../dd-trace/src/log')
const { isFalse } = require('../../../dd-trace/src/util')
const shimmer = require('../../../datadog-shimmer')
const RealtimeSession = require('./session')

/**
 * @typedef {import('./session').TurnDescriptor} TurnDescriptor
 * @typedef {import('./turns').ResponseTurn} ResponseTurn
 */

// One span per phase of a turn. `user speech` and `agent speech` share a channel: they differ only
// by name and resource, which is data, not a type.
const turnChannel = dc.tracingChannel('apm:openai:realtime:turn')
const responseChannel = dc.tracingChannel('apm:openai:realtime:response')
const speechChannel = dc.tracingChannel('apm:openai:realtime:speech')

// Published once per turn at `response.created`. The tracing and LLM Observability plugins each
// compose a `runInContext` onto the turn, so the tree replayed at finalize nests under whatever
// context the caller had active — the active context at finalize is the socket's, not theirs.
const captureContextChannel = dc.channel('dd-trace:openai:realtime:capture-context')

const USER_SPEECH = { operation: 'createRealtimeUserSpeech', llmobsName: 'user speech' }
const AGENT_SPEECH = { operation: 'createRealtimeAgentSpeech', llmobsName: 'agent speech' }

/** @type {WeakMap<object, { session: RealtimeSession, finalize: () => void }>} */
const connections = new WeakMap()

/**
 * Live sessions, weakly, so a process exiting without closing its connections still reports the
 * turns they hold. Weak because a realtime connection can outlive many turns and we must not be the
 * reason one stays reachable.
 *
 * @type {Set<WeakRef<RealtimeSession>>}
 */
const liveSessions = new Set()

function noop () {}

/**
 * @param {() => void} fn
 * @returns {void}
 */
function runNow (fn) {
  fn()
}

/**
 * Replay a finished turn as a back-dated span tree. Nesting falls out of the synchronous scoping of
 * `traceSync`: the phase spans are created inside the turn root's callback, so each picks the root
 * up as its parent from the active store without any explicit parent stamping.
 *
 * @param {TurnDescriptor} turn
 * @returns {void}
 */
function emitTurn (turn) {
  const run = turn.runInContext ?? runNow

  run(() => {
    turnChannel.traceSync(() => {
      const { userSpeech, agentSpeech } = turn

      if (userSpeech !== undefined) {
        speechChannel.traceSync(noop, { turn, phase: USER_SPEECH, ...userSpeech })
      }

      responseChannel.traceSync(noop, {
        turn,
        startTime: turn.llm.startTime,
        finishTime: turn.llm.finishTime,
      })

      if (agentSpeech !== undefined) {
        speechChannel.traceSync(noop, { turn, phase: AGENT_SPEECH, ...agentSpeech })
      }
    }, { turn, startTime: turn.root.startTime, finishTime: turn.root.finishTime })
  })
}

/**
 * @param {ResponseTurn} turn
 * @returns {void}
 */
function captureContext (turn) {
  if (captureContextChannel.hasSubscribers) captureContextChannel.publish(turn)
}

/**
 * Start tracking a connection, reading the model and base path off the URL the SDK already built.
 *
 * @param {object} emitter
 * @returns {{ session: RealtimeSession, finalize: () => void }}
 */
function createConnection (emitter) {
  let model
  let basePath = ''

  try {
    const { url } = emitter
    if (url) {
      // Azure names it `deployment`; a sideband `call_id` connection has neither, and picks the
      // model up from `session.created` instead.
      model = url.searchParams.get('model') ?? url.searchParams.get('deployment') ?? undefined
      // Origin and path only. The query string carries `Authorization` / `api-key` on the Azure
      // path, before the SDK redacts them.
      basePath = url.origin + url.pathname
    }
  } catch {
    // The URL shape is not guaranteed across SDK versions; the session works without it.
  }

  const session = new RealtimeSession({ emitTurn, captureContext, model, basePath })

  const reference = new WeakRef(session)
  liveSessions.add(reference)

  const finalize = () => {
    liveSessions.delete(reference)
    session.finishSession(Date.now())
  }

  const connection = { session, finalize }
  attachSocketClose(emitter, finalize)
  return connection
}

/**
 * Finalize when the server closes the connection, so a caller that never calls `close()` — or whose
 * connection drops — still reports its turns. `close` alone covers both transports: `ws` emits
 * `error` then always `close`, and a global `WebSocket` that fails to connect does the same.
 *
 * @param {object} emitter
 * @param {() => void} finalize
 * @returns {void}
 */
function attachSocketClose (emitter, finalize) {
  try {
    const { socket } = emitter
    if (socket == null) return

    // `ws` sockets are Node EventEmitters and also expose `addEventListener`, so check `on` first.
    if (typeof socket.on === 'function') {
      socket.once('close', finalize)
    } else if (typeof socket.addEventListener === 'function') {
      socket.addEventListener('close', finalize, { once: true })
    }
  } catch (error) {
    log.debug('Error attaching OpenAI realtime close listener: %s', error?.message)
  }
}

/**
 * @param {object} emitter
 * @returns {{ session: RealtimeSession, finalize: () => void } | undefined}
 */
function getConnection (emitter) {
  const connection = connections.get(emitter)
  if (connection !== undefined) return connection

  // Nothing is listening, so never allocate. Checked only on the miss path, so an established
  // connection pays one WeakMap lookup per event.
  if (!turnChannel.start.hasSubscribers) return

  const created = createConnection(emitter)
  connections.set(emitter, created)
  return created
}

/**
 * Wrap the emitter's `_emit` — the single funnel every server event passes through, ahead of the
 * app's own listeners.
 *
 * `_emit` is inherited from the SDK's generic `EventEmitter`, which its streaming helpers also use;
 * `shimmer.wrap` defines an own property on the realtime prototype instead of touching that shared
 * one.
 *
 * @param {object} prototype
 * @returns {void}
 */
function patchRealtimeEmitter (prototype) {
  if (prototype == null) return

  shimmer.wrap(prototype, '_emit', _emit => function (name, event) {
    // `_emit` fires twice per server event — once as `event`, once as the event's own type — so the
    // second half of the traffic is eliminated by a pointer compare before any other work.
    if (name === 'event') {
      const connection = getConnection(this)
      // Observed before the app's listeners run: this feature is timestamps, and the app's own
      // audio-playback callbacks would otherwise land inside the measured window.
      if (connection !== undefined) connection.session.onServerEvent(event, Date.now())
    }

    return _emit.apply(this, arguments)
  })
}

/**
 * Wrap a concrete realtime transport's `send` (every client event) and `close` (session end).
 *
 * @param {object} prototype
 * @returns {void}
 */
function patchRealtimeTransport (prototype) {
  if (prototype == null) return

  shimmer.wrap(prototype, 'send', send => function (event) {
    // Recorded only after the send succeeds, so a failed send doesn't attribute unsent audio to the
    // next turn.
    const result = send.apply(this, arguments)

    const connection = getConnection(this)
    if (connection !== undefined) connection.session.onClientEvent(event, Date.now())

    return result
  })

  shimmer.wrap(prototype, 'close', close => function () {
    const connection = connections.get(this)
    try {
      return close.apply(this, arguments)
    } finally {
      connection?.finalize()
    }
  })
}

/**
 * Realtime is a large wrapping surface that buffers audio in memory, so it can be turned off on its
 * own without giving up the rest of the OpenAI integration.
 *
 * @returns {boolean}
 */
function realtimeEnabled () {
  return !isFalse(getEnvironmentVariable('DD_OPENAI_REALTIME_ENABLED'))
}

/**
 * Submit whatever live sessions still hold, at process exit.
 *
 * This is the only backstop for a connection the app drops without closing. A `FinalizationRegistry`
 * would not help: the socket's own `message` handler closes over the emitter, and libuv holds the
 * socket for as long as the connection is open, so the emitter is never unreachable while there is
 * anything left to report.
 *
 * @returns {void}
 */
function flushLiveSessions () {
  for (const reference of liveSessions) {
    const session = reference.deref()
    if (session === undefined) {
      liveSessions.delete(reference)
      continue
    }
    // Idempotent, so a session already closed by `close()` or a socket close costs nothing here.
    session.finishSession(Date.now())
  }
  liveSessions.clear()
}

globalThis[Symbol.for('dd-trace')]?.beforeExitHandlers?.add(flushLiveSessions)

module.exports = {
  flushLiveSessions,
  patchRealtimeEmitter,
  patchRealtimeTransport,
  realtimeEnabled,
}
