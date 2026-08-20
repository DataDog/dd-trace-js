'use strict'

const { channel } = require('dc-polyfill')

const { HTTP_METHOD, HTTP_ROUTE, RESOURCE_NAME, SPAN_TYPE } = require('../../../../ext/tags')
const { WEB } = require('../../../../ext/types')

const HTTP_ENDPOINT = 'http.endpoint'
const INFERRED_SPAN = '_inferred_span'
const COMPONENT = 'component'
const USER_ID = 'usr.id'
const USER_SESSION_ID = 'usr.session_id'

const spans = new WeakMap()
const contexts = new WeakMap()
const traces = new WeakMap()

const spanStartedCh = channel('dd-trace:span:event-writer:span-started')
const tagsClearedCh = channel('dd-trace:span:event-writer:tags-cleared')
const tagDeletedCh = channel('dd-trace:span:event-writer:tag-deleted')
const tagSetCh = channel('dd-trace:span:event-writer:tag-set')
const tagsSetCh = channel('dd-trace:span:event-writer:tags-set')
const traceSpansReplacedCh = channel('dd-trace:span:event-writer:trace-spans-replaced')

function getTraceProjection (trace) {
  let projection = traces.get(trace)
  if (projection === undefined) {
    projection = new Map()
    traces.set(trace, projection)
  }
  return projection
}

/**
 * Capture the immutable topology and identifiers needed by downstream consumers.
 * This is called only from the EventWriter span-start path.
 *
 * @param {import('./span')} span
 * @param {import('./span_context')} context
 * @param {object} [fields]
 */
function startSpan (span, context, fields = {}) {
  const trace = getTraceProjection(fields.traceIdentity ?? context._trace)
  const parent = trace.get(fields.parentId ?? context._parentId)
  const projection = {
    errorState: 0,
    span,
    parent,
    parentId: fields.parentId ?? context._parentId,
    localRoot: parent?.localRoot ?? span,
    spanId: fields.spanId ?? context._spanId,
    tags: Object.create(null),
  }
  spans.set(span, projection)
  contexts.set(context, projection)
  trace.set(projection.spanId, projection)
}

function getProjection (target) {
  return typeof target?.context === 'function' ? spans.get(target) : contexts.get(target)
}

/**
 * Update the selected tag projection needed by AppSec and profiling consumers.
 *
 * @param {import('./span')|import('./span_context')} target
 * @param {string} key
 * @param {unknown} value
 */
function setTag (target, key, value) {
  const projection = getProjection(target)
  if (projection === undefined || typeof key !== 'string') return

  if (key === 'appsec.event') {
    if (value === 'true') {
      projection.appSecEventTags ??= new Set()
      projection.appSecEventTags.add(key)
    } else {
      projection.appSecEventTags?.delete(key)
    }
  } else if (key.startsWith('appsec.events.')) {
    projection.appSecEventTags ??= new Set()
    projection.appSecEventTags.add(key)
  }

  if (key === 'error') {
    projection.errorState = value ? projection.errorState | 1 : projection.errorState & ~1
  } else if (key === 'error.type') {
    projection.errorState = value ? projection.errorState | 2 : projection.errorState & ~2
  }

  switch (key) {
    case HTTP_METHOD:
    case HTTP_ROUTE:
    case RESOURCE_NAME:
    case SPAN_TYPE:
    case HTTP_ENDPOINT:
    case COMPONENT:
    case USER_ID:
    case USER_SESSION_ID:
      projection.tags[key] = value
      break
    case INFERRED_SPAN:
      projection.inferred = value !== undefined && value !== false
      break
  }
}

/**
 * @param {import('./span')|import('./span_context')} target
 * @param {Record<string, unknown>} tags
 */
function setTags (target, tags) {
  for (const key of Object.keys(tags)) {
    setTag(target, key, tags[key])
  }
}

/**
 * @param {import('./span')|import('./span_context')} target
 * @param {string} key
 */
function deleteTag (target, key) {
  const projection = getProjection(target)
  if (projection === undefined) return
  projection.appSecEventTags?.delete(key)
  if (key === 'error') {
    projection.errorState &= ~1
  } else if (key === 'error.type') {
    projection.errorState &= ~2
  }
  if (key === INFERRED_SPAN) {
    projection.inferred = false
  } else {
    delete projection.tags[key]
  }
}

/**
 * @param {import('./span')|import('./span_context')} target
 */
function clearTags (target) {
  const projection = getProjection(target)
  if (projection === undefined) return
  projection.tags = Object.create(null)
  projection.errorState = 0
  projection.inferred = false
  projection.appSecEventTags?.clear()
}

function onSpanStarted ({ span, context, traceIdentity, spanId, parentId }) {
  startSpan(span, context, { traceIdentity, spanId, parentId })
}

function onTagSet ({ context, key, value }) {
  setTag(context, key, value)
}

function onTagsSet ({ context, tags }) {
  setTags(context, tags)
}

function onTagDeleted ({ context, key }) {
  deleteTag(context, key)
}

function onTagsCleared ({ context }) {
  clearTags(context)
}

function onTraceSpansReplaced ({ traceIdentity, activeSpans }) {
  const active = new Map()

  for (const span of activeSpans) {
    const projection = spans.get(span)
    if (projection === undefined) continue

    projection.parent = active.get(projection.parentId)
    projection.localRoot = projection.parent?.localRoot ?? span
    active.set(projection.spanId, projection)
  }

  traces.set(traceIdentity, active)
}

/**
 * Return the local root span while excluding inferred-proxy ancestors.
 *
 * @param {import('./span')} span
 * @returns {import('./span')|undefined}
 */
function getAppSecRootSpan (span) {
  const active = spans.get(span)
  if (active === undefined) return

  let root = active
  let current = active.parent
  while (current !== undefined) {
    if (!current.inferred) root = current
    current = current.parent
  }
  return root.span
}

/**
 * @param {import('./span')} span
 * @returns {import('./span')|undefined}
 */
function getLocalRootSpan (span) {
  return spans.get(span)?.localRoot
}

/**
 * Return the selected web tag projection for the span itself.
 *
 * @param {import('./span')} span
 * @returns {Record<string, unknown>|undefined}
 */
function getOwnWebTags (span) {
  const projection = spans.get(span)
  return projection?.tags
}

/**
 * @param {import('./span')} span
 * @returns {import('./span')|undefined}
 */
function getParentSpan (span) {
  return spans.get(span)?.parent?.span
}

/**
 * @param {import('./span')} span
 * @returns {{ spanId: unknown, localRootSpanId: unknown }|undefined}
 */
function getCodeHotspotIds (span) {
  const projection = spans.get(span)
  if (projection === undefined) return
  return {
    spanId: projection.spanId,
    localRootSpanId: spans.get(projection.localRoot)?.spanId,
  }
}

/**
 * @param {import('./span')} span
 * @returns {string|undefined}
 */
function getHttpEndpoint (span) {
  const value = spans.get(span)?.tags[HTTP_ENDPOINT]
  return typeof value === 'string' ? value : undefined
}

/**
 * @param {import('./span')} span
 * @returns {string|undefined}
 */
function getApiSecurityFramework (span) {
  const value = spans.get(span)?.tags[COMPONENT]
  return typeof value === 'string' ? value : undefined
}

/**
 * @param {import('./span')} span
 * @returns {string|undefined}
 */
function getApiSecurityHttpRoute (span) {
  const value = spans.get(span)?.tags[HTTP_ROUTE]
  return typeof value === 'string' ? value : undefined
}

/**
 * @param {import('./span')} span
 * @returns {boolean}
 */
function hasUserId (span) {
  return Boolean(spans.get(span)?.tags[USER_ID])
}

/**
 * @param {import('./span')} span
 * @returns {boolean}
 */
function hasUserSessionId (span) {
  return Boolean(spans.get(span)?.tags[USER_SESSION_ID])
}

/**
 * Return whether the span has an error without exposing its tag state.
 *
 * @param {import('./span')} span
 * @returns {boolean}
 */
function hasError (span) {
  return (spans.get(span)?.errorState ?? 0) !== 0
}

/**
 * @param {import('./span')} span
 * @returns {boolean}
 */
function isOutermostWebSpan (span) {
  let projection = spans.get(span)
  if (projection?.tags[SPAN_TYPE] !== WEB) return false

  projection = projection.parent
  while (projection !== undefined) {
    if (projection.tags[SPAN_TYPE] === WEB) return false
    projection = projection.parent
  }
  return true
}

/**
 * @param {import('./span')} span
 * @returns {boolean}
 */
function shouldCollectAppSecEventHeaders (span) {
  return (spans.get(span)?.appSecEventTags?.size ?? 0) > 0
}

spanStartedCh.subscribe(onSpanStarted)
tagsClearedCh.subscribe(onTagsCleared)
tagDeletedCh.subscribe(onTagDeleted)
tagSetCh.subscribe(onTagSet)
tagsSetCh.subscribe(onTagsSet)
traceSpansReplacedCh.subscribe(onTraceSpansReplaced)

module.exports = {
  clearTags,
  deleteTag,
  getApiSecurityFramework,
  getApiSecurityHttpRoute,
  getAppSecRootSpan,
  getCodeHotspotIds,
  getHttpEndpoint,
  getLocalRootSpan,
  getOwnWebTags,
  getParentSpan,
  hasError,
  hasUserId,
  hasUserSessionId,
  isOutermostWebSpan,
  setTag,
  setTags,
  shouldCollectAppSecEventHeaders,
  startSpan,
}
