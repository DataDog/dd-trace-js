'use strict'

const dc = require('dc-polyfill')

const log = require('../../dd-trace/src/log')
const shimmer = require('../../datadog-shimmer')
const Session = require('./elevenlabs/session')

const spanCh = dc.tracingChannel('apm:elevenlabs:span')
const finishCh = dc.channel('apm:elevenlabs:finish')
const captureCh = dc.channel('dd-trace:elevenlabs:capture-context')
const audioCh = dc.channel('dd-trace:elevenlabs:audio')
const sessions = new WeakMap()
const tools = new WeakMap()
const emitters = new WeakSet()
const live = new Set()
const collected = new FinalizationRegistry(reference => live.delete(reference))
let handling

/** @param {() => unknown} fn */
function observe (fn) {
  try { fn() } catch (error) { log.debug('ElevenLabs instrumentation: %s', error?.message) }
}

/**
 * @param {object} scope
 * @param {() => unknown} fn
 */
function run (scope, fn) { return scope.runInContext ? scope.runInContext(fn) : fn() }

/**
 * @param {Session} session
 * @param {import('./elevenlabs/session').Turn} turn
 */
function begin (session, turn) {
  run(session.scope, () => {
    turn.root = {
      session,
      turn,
      kind: 'workflow',
      name: 'elevenlabs audio turn',
      startTime: turn.start,
      deferred: true,
    }
    spanCh.traceSync(() => {
      captureCh.publish(turn.scope)
      turn.llm = { session, turn, kind: 'llm', name: 'elevenlabs response', startTime: Date.now(), deferred: true }
      spanCh.traceSync(() => {}, turn.llm)
    }, turn.root)
  })
}

/**
 * @param {Session} session
 * @param {import('./elevenlabs/session').Turn} turn
 */
function finish (session, turn) {
  const text = [...turn.responses.values()].filter(Boolean).join('\n').slice(0, 100_000)
  turn.text = text
  turn.sessionId = session.sessionId
  turn.inputRate = session.inputRate
  turn.outputRate = session.outputRate
  run(turn.scope, () => {
    for (const ctx of turn.tools) {
      turn.metadata.tool_execution_incomplete = true
      ctx.finishTime = Date.now()
      finishCh.publish(ctx)
    }
    turn.tools.clear()
    /** @type {[string, import('./elevenlabs/audio').AudioBuffer, number, string][]} */
    const phases = [
      ['user speech', turn.input, session.inputRate, turn.userText],
      ['agent speech', turn.output, session.outputRate, text],
    ]
    for (const [name, audio, rate, transcript] of phases) {
      const end = audio.end(rate)
      if (audio.start === undefined || end === undefined || !(end > audio.start)) continue
      const activity = name === 'user speech' && !audio.overflow
        ? audio.activity.metadata(audio.duration(rate), audio.lastAudio)
        : undefined
      spanCh.traceSync(() => {}, {
        session, turn, kind: 'workflow', name, startTime: audio.start, finishTime: end, transcript, activity,
      })
    }
    turn.llm.finishTime = Math.max(turn.llm.startTime, turn.responseTime)
    finishCh.publish(turn.llm)
    turn.root.finishTime = Math.max(turn.start, turn.responseTime, turn.toolEnd,
      turn.input.end(session.inputRate) || 0, turn.output.end(session.outputRate) || 0)
    finishCh.publish(turn.root)
  })
}

/** @param {object} conversation */
function create (conversation) {
  const session = new Session({
    agentId: conversation.agentId,
    begin: turn => begin(session, turn),
    finish: turn => finish(session, turn),
    retain: () => audioCh.hasSubscribers,
  })
  session.scope = {}
  captureCh.publish(session.scope)
  const reference = new WeakRef(session)
  live.add(reference)
  collected.register(session, reference, reference)
  session.finalize = failed => {
    live.delete(reference)
    collected.unregister(reference)
    session.close(Date.now(), failed)
    session.scope = {}
  }
  sessions.set(conversation, session)
  if (!emitters.has(conversation)) {
    emitters.add(conversation)
    // emit is inherited from Node's EventEmitter, outside the SDK's rewriteable source.
    // Observe only this runtime instance; an error listener would change unhandled-error behavior.
    shimmer.wrap(conversation, 'emit', emit => function (event) {
      if (event === 'error') observe(() => sessions.get(this)?.finalize(true))
      return emit.apply(this, arguments)
    })
  }
  return session
}

/**
 * @param {Session} session
 * @param {object} socket
 */
function attach (session, socket) {
  if (!socket || session.socket === socket) return
  session.socket = socket
  // Custom factories produce runtime socket instances; rewriting ws would miss these and
  // instrument unrelated connections. Observe only this conversation's accepted sends.
  shimmer.wrap(socket, 'send', send => function (data) {
    const result = send.apply(this, arguments)
    observe(() => {
      if (typeof data === 'string') session.send(JSON.parse(data), Date.now())
    })
    return result
  })
}

/** @param {string} method */
function channel (method) { return dc.tracingChannel(`orchestrion:@elevenlabs/elevenlabs-js:${method}`) }

channel('startSession').subscribe({
  start (ctx) {
    if (!spanCh.start.hasSubscribers || ctx.self.ws) return
    observe(() => { ctx.session = create(ctx.self) })
  },
  error (ctx) { if (ctx.session) observe(() => ctx.session.finalize(true)) },
})
channel('_onWebSocketOpen').start.subscribe(ctx => {
  observe(() => {
    const session = sessions.get(ctx.self)
    if (session) attach(session, ctx.self.ws)
  })
})
channel('_handleMessage').subscribe({
  start (ctx) {
    ctx.previous = handling
    handling = undefined
    observe(() => {
      const session = sessions.get(ctx.self)
      if (!session || ctx.self.shouldStop) return
      const turn = session.receive(ctx.arguments[0], Date.now())
      handling = turn ? { session, turn } : undefined
    })
  },
  end (ctx) { handling = ctx.previous },
})
channel('endSession').end.subscribe(ctx => {
  observe(() => sessions.get(ctx.self)?.finalize(Boolean(ctx.error)))
})
for (const method of ['_onWebSocketOpen', '_handleMessage']) {
  channel(method).error.subscribe(ctx => {
    observe(() => sessions.get(ctx.self)?.finalize(true))
  })
}
channel('_onWebSocketClose').start.subscribe(ctx => {
  const code = ctx.arguments[0]
  observe(() => sessions.get(ctx.self)?.finalize(!ctx.self.shouldStop && ![1000, 1001, 1005].includes(code)))
})
channel('executeToolAsync').start.subscribe(ctx => {
  if (handling && ctx.arguments[1] && typeof ctx.arguments[1] === 'object') {
    tools.set(ctx.arguments[1], handling)
  }
})
channel('register').start.subscribe(ctx => {
  const handler = ctx.arguments[1]
  if (typeof handler !== 'function' || !spanCh.start.hasSubscribers) return
  if (ctx.arguments[2] === undefined) ctx.arguments[2] = handler.constructor.name === 'AsyncFunction'
  // Customer handlers are created at runtime and have no matchable SDK source function.
  ctx.arguments[1] = shimmer.wrapCallback(handler, original => function (parameters) {
    const owner = tools.get(parameters)
    if (!owner || owner.turn.closed || !spanCh.start.hasSubscribers) return original.apply(this, arguments)
    const { session, turn } = owner
    const id = parameters.tool_call_id
    if (!turn.calls.has(id)) return original.apply(this, arguments)
    if (turn.tools.size >= 64) {
      turn.metadata.tool_spans_omitted = true
      return run(turn.scope, () => original.apply(this, arguments))
    }
    const tool = {
      session,
      turn,
      kind: 'tool',
      name: turn.calls.get(id).name,
      id,
      parameters,
      startTime: Date.now(),
      promise: true,
    }
    turn.tools.add(tool)
    return run(turn.scope, () => spanCh.tracePromise(original, tool, this, ...arguments))
  })
})
spanCh.error.subscribe(ctx => {
  if (ctx.kind === 'tool') ctx.promise = false
})
spanCh.end.subscribe(ctx => {
  if (ctx.kind !== 'tool' || !ctx.error || ctx.finished) return
  observe(() => {
    ctx.output = ctx.session.toolResult(ctx.turn, ctx.id, String(ctx.error))
    ctx.finishTime = Date.now()
    ctx.turn.toolEnd = Math.max(ctx.turn.toolEnd, ctx.finishTime)
    ctx.turn.tools.delete(ctx)
  })
})
// Registered before product subscribers, so annotations observe the bounded result and duration.
spanCh.asyncEnd.subscribe(ctx => {
  if (ctx.kind !== 'tool' || ctx.finished) return
  observe(() => {
    ctx.output = ctx.session.toolResult(ctx.turn, ctx.id, ctx.error ? String(ctx.error) : ctx.result)
    ctx.finishTime = Date.now()
    ctx.turn.toolEnd = Math.max(ctx.turn.toolEnd, ctx.finishTime)
    ctx.turn.tools.delete(ctx)
  })
})

const beforeExitHandlers = globalThis[Symbol.for('dd-trace')]?.beforeExitHandlers
beforeExitHandlers?.add(() => {
  for (const reference of live) observe(() => reference.deref()?.finalize(true))
  live.clear()
})
