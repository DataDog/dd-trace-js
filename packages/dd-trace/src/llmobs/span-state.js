'use strict'

const { channel } = require('dc-polyfill')
const {
  PROPAGATED_ML_APP_KEY,
  PROPAGATED_PARENT_AGENT_ID_KEY,
  PROPAGATED_PARENT_AGENT_NAME_KEY,
  PROPAGATED_PARENT_ID_KEY,
  PROPAGATED_SAMPLE_RATE_KEY,
  PROPAGATED_SAMPLING_DECISION_KEY,
  PROPAGATED_SESSION_ID_KEY,
  PROPAGATED_TRACE_ID_KEY,
  SESSION_ID_TRACE_DEFAULT_KEY,
} = require('./constants/tags')

const contextInitializedCh = channel('dd-trace:span:event-writer:context-initialized')
const spanStartedCh = channel('dd-trace:span:event-writer:span-started')
const tagsClearedCh = channel('dd-trace:span:event-writer:tags-cleared')
const tagDeletedCh = channel('dd-trace:span:event-writer:tag-deleted')
const tagSetCh = channel('dd-trace:span:event-writer:tag-set')
const tagsSetCh = channel('dd-trace:span:event-writer:tags-set')
const traceTagSetCh = channel('dd-trace:span:event-writer:trace-tag-set')
const traceTagsSetCh = channel('dd-trace:span:event-writer:trace-tags-set')

const propagatedKeys = new Set([
  PROPAGATED_ML_APP_KEY,
  PROPAGATED_PARENT_AGENT_ID_KEY,
  PROPAGATED_PARENT_AGENT_NAME_KEY,
  PROPAGATED_PARENT_ID_KEY,
  PROPAGATED_SAMPLE_RATE_KEY,
  PROPAGATED_SAMPLING_DECISION_KEY,
  PROPAGATED_SESSION_ID_KEY,
  PROPAGATED_TRACE_ID_KEY,
  SESSION_ID_TRACE_DEFAULT_KEY,
])

const contexts = new WeakMap()
const spans = new WeakMap()
const traces = new WeakMap()
let enabled = false

function createTraceState () {
  return { tags: Object.create(null) }
}

function getContextState (context) {
  let state = contexts.get(context)
  if (state === undefined) {
    state = { trace: createTraceState() }
    contexts.set(context, state)
  }
  return state
}

function onContextInitialized ({ context, traceIdentity }) {
  let trace = traces.get(traceIdentity)
  if (trace === undefined) {
    trace = createTraceState()
    traces.set(traceIdentity, trace)
  }
  contexts.set(context, { trace })
}

function onSpanStarted ({ span, context, parentContext, operationName, startTime }) {
  const contextState = getContextState(context)
  const parentSpan = contexts.get(parentContext)?.span
  spans.set(span, {
    context,
    errorKeys: new Set(),
    genAIKeys: new Set(),
    name: operationName,
    parent: spans.get(parentSpan),
    startTime,
    trace: contextState.trace,
  })
  contextState.span = span
}

function onTagSet ({ context, key, value }) {
  const span = contexts.get(context)?.span
  const state = spans.get(span)
  if (state === undefined) return

  if (key === 'error' || key === 'error.type') {
    if (value) state.errorKeys.add(key)
    else state.errorKeys.delete(key)
  }
  if (key.startsWith('gen_ai.')) {
    if (value === undefined) state.genAIKeys.delete(key)
    else state.genAIKeys.add(key)
  }
}

function onTagsSet ({ context, tags }) {
  for (const key of Object.keys(tags)) {
    onTagSet({ context, key, value: tags[key] })
  }
}

function onTagDeleted ({ context, key }) {
  const state = spans.get(contexts.get(context)?.span)
  if (state === undefined) return
  if (key === 'error' || key === 'error.type') state.errorKeys.delete(key)
  if (key.startsWith('gen_ai.')) state.genAIKeys.delete(key)
}

function onTagsCleared ({ context }) {
  const state = spans.get(contexts.get(context)?.span)
  if (state === undefined) return
  state.errorKeys.clear()
  state.genAIKeys.clear()
}

function onTraceTagSet ({ context, key, value }) {
  if (!propagatedKeys.has(key)) return
  getContextState(context).trace.tags[key] = value
}

function onTraceTagsSet ({ context, tags }) {
  for (const key of Object.keys(tags)) {
    if (propagatedKeys.has(key)) getContextState(context).trace.tags[key] = tags[key]
  }
}

function enable () {
  if (enabled) return
  enabled = true
  contextInitializedCh.subscribe(onContextInitialized)
  spanStartedCh.subscribe(onSpanStarted)
  tagsClearedCh.subscribe(onTagsCleared)
  tagDeletedCh.subscribe(onTagDeleted)
  tagSetCh.subscribe(onTagSet)
  tagsSetCh.subscribe(onTagsSet)
  traceTagSetCh.subscribe(onTraceTagSet)
  traceTagsSetCh.subscribe(onTraceTagsSet)
}

function disable () {
  if (!enabled) return
  enabled = false
  contextInitializedCh.unsubscribe(onContextInitialized)
  spanStartedCh.unsubscribe(onSpanStarted)
  tagsClearedCh.unsubscribe(onTagsCleared)
  tagDeletedCh.unsubscribe(onTagDeleted)
  tagSetCh.unsubscribe(onTagSet)
  tagsSetCh.unsubscribe(onTagsSet)
  traceTagSetCh.unsubscribe(onTraceTagSet)
  traceTagsSetCh.unsubscribe(onTraceTagsSet)
}

function getOperationName (span) {
  return spans.get(span)?.name
}

function getStartTime (span) {
  return spans.get(span)?.startTime
}

function getTraceTags (target) {
  const state = typeof target?.context === 'function'
    ? spans.get(target) ?? contexts.get(target.context())
    : contexts.get(target)
  return state?.trace.tags
}

function hasError (span) {
  return (spans.get(span)?.errorKeys.size ?? 0) > 0
}

function findGenAIAncestorSpanId (span) {
  let parent = spans.get(span)?.parent
  while (parent !== undefined) {
    if (parent.genAIKeys.size > 0) return parent.context.toSpanId()
    parent = parent.parent
  }
  return null
}

module.exports = {
  disable,
  enable,
  findGenAIAncestorSpanId,
  getOperationName,
  getStartTime,
  getTraceTags,
  hasError,
}
