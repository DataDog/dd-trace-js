'use strict'

const dc = require('dc-polyfill')

const { getValueFromEnvSources } = require('../../../dd-trace/src/config/helper')
const log = require('../../../dd-trace/src/log')
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

// Never published on — subscribed to as a capability signal, the way `captureContextChannel` is
// probed before publishing. Only LLM Observability consumes a turn's audio bytes (the tracing
// plugins read the model and the phase boundaries), and a disabled plugin unsubscribes its channels,
// so `hasSubscribers` here is exactly "someone will read the audio". Without it the default
// APM-only configuration decodes and buffers every frame of every turn for no consumer.
//
// A dedicated channel is what makes the distinction possible: the two plugin families share the
// `apm:openai:realtime:*` prefixes, so the turn channel cannot tell them apart.
const audioChannel = dc.channel('dd-trace:openai:realtime:audio')

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
 * Replay a finished turn as a back-dated span tree. Nesting falls out of the synchronous scoping of
 * `traceSync`: the phase spans are created inside the turn root's callback, so each picks the root
 * up as its parent from the active store without any explicit parent stamping.
 *
 * @param {TurnDescriptor} turn
 */
function emitTurn (turn) {
  const run = turn.runInContext ?? (fn => fn())

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

  // Asked per segment rather than snapshotted here: a plugin can be reconfigured while a connection
  // is open, and a session that outlived its consumer would otherwise keep buffering audio nothing
  // reads.
  const session = new RealtimeSession({
    emitTurn,
    captureContext,
    model,
    basePath,
    shouldRetainAudio: () => audioChannel.hasSubscribers,
  })

  const reference = new WeakRef(session)
  liveSessions.add(reference)

  /**
   * @param {boolean} [failed] - Whether the connection ended abnormally, so a response still in
   *   flight is reported as failed rather than as a clean finish.
   */
  const finalize = (failed = false) => {
    liveSessions.delete(reference)
    session.finishSession(Date.now(), failed)
  }

  const connection = { session, finalize }
  attachSocketClose(emitter, finalize)
  return connection
}

// Close codes that mean the conversation ended on purpose: a normal close, the peer going away, and
// the "no status received" code `ws` reports for a close frame that carried none. Anything else — a
// dropped connection (1006), an internal error (1011) — cut a response short, so a turn still in
// flight is a failure rather than a clean finish.
const NORMAL_CLOSE_CODES = new Set([1000, 1001, 1005])

/**
 * @param {unknown} code
 */
function isAbnormalClose (code) {
  return typeof code === 'number' && !NORMAL_CLOSE_CODES.has(code)
}

/**
 * Finalize when the server closes the connection, so a caller that never calls `close()` — or whose
 * connection drops — still reports its turns. `close` alone covers both transports: `ws` emits
 * `error` then always `close`, and a global `WebSocket` that fails to connect does the same.
 *
 * @param {object} emitter
 * @param {(failed?: boolean) => void} finalize
 */
function attachSocketClose (emitter, finalize) {
  try {
    const { socket } = emitter
    if (socket == null) return

    // `ws` sockets are Node EventEmitters and also expose `addEventListener`, so check `on` first.
    // The close code arrives as an argument on the `ws` surface and on the `CloseEvent` on the DOM
    // one; an app-initiated `close()` goes through the shim below instead and is never flagged.
    if (typeof socket.on === 'function') {
      socket.once('close', code => finalize(isAbnormalClose(code)))
    } else if (typeof socket.addEventListener === 'function') {
      socket.addEventListener('close', event => finalize(isAbnormalClose(event?.code)), { once: true })
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
      // In a `finally` deliberately. Every realtime transport wraps `socket.close()` in its own
      // try/catch and routes a failure to `_onError` (which rejects a promise rather than
      // rethrowing), so this call does not throw and the two placements are equivalent today —
      // but if that ever changes, finalizing is what keeps the session from leaking. The socket's
      // close event is the other half of that guarantee.
      connection?.finalize()
    }
  })
}

/**
 * Realtime is a large wrapping surface that buffers audio in memory, so it can be turned off on its
 * own without giving up the rest of the OpenAI integration.
 *
 * Read through every configuration source, not just `process.env`: this is an operator-facing kill
 * switch, and an org that sets it through Fleet Automation or local stable config would otherwise
 * see it reported as disabled in configuration telemetry while the patching stayed on. Resolving it
 * here also applies the option's registered boolean parser and its `true` default.
 */
function realtimeEnabled () {
  return getValueFromEnvSources('DD_OPENAI_REALTIME_ENABLED') !== false
}

/**
 * Submit whatever live sessions still hold, at process exit.
 *
 * This is the only backstop for a connection the app drops without closing. A `FinalizationRegistry`
 * would not help: the socket's own `message` handler closes over the emitter, and libuv holds the
 * socket for as long as the connection is open, so the emitter is never unreachable while there is
 * anything left to report.
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
