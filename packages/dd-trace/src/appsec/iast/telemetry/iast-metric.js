'use strict'

const { getNamespaceFromContext, globalNamespace } = require('./namespaces')

const Scope = {
  GLOBAL: 'GLOBAL',
  REQUEST: 'REQUEST'
}

const PropagationType = {
  STRING: 'STRING',
  JSON: 'JSON',
  URL: 'URL'
}

const TagKey = {
  VULNERABILITY_TYPE: 'vulnerability_type',
  SOURCE_TYPE: 'source_type',
  PROPAGATION_TYPE: 'propagation_type'
}

function formatTags (tags, tagKey) {
  return tags.map(tagValue => tagValue ? [`${tagKey}:${tagValue.toLowerCase()}`] : undefined)
}

function getNamespace (scope, context) {
  let namespace = globalNamespace

  if (scope === Scope.REQUEST) {
    namespace = getNamespaceFromContext(context) || globalNamespace
  }
  return namespace
}

class IastMetric {
  constructor (name, scope, tagKey) {
    this.name = name
    this.scope = scope
    this.tagKey = tagKey
  }

  formatTags (...tags) {
    return formatTags(tags, this.tagKey)
  }

  // tags should be an array [tagKey:tagValue]
  add (context, value, tags) {
    const namespace = getNamespace(this.scope, context)
    namespace.getMetric(this.name, tags).inc(value)
  }

  inc (context, tags) {
    this.add(context, 1, tags)
  }
}

class NoTaggedIastMetric extends IastMetric {
  constructor (name, scope) {
    super(name, scope)

    this.tags = []
  }

  add (context, value) {
    const namespace = getNamespace(this.scope, context)
    namespace.getMetric(this.name, this.tags).inc(value)
  }

  inc (context) {
    this.add(context, 1)
  }
}

function getExecutedMetric (tagKey) {
  return tagKey === TagKey.VULNERABILITY_TYPE ? EXECUTED_SINK : EXECUTED_SOURCE
}

function getInstrumentedMetric (tagKey) {
  return tagKey === TagKey.VULNERABILITY_TYPE ? INSTRUMENTED_SINK : INSTRUMENTED_SOURCE
}

const INSTRUMENTED_PROPAGATION = new NoTaggedIastMetric('instrumented.propagation', Scope.GLOBAL)
const INSTRUMENTED_SOURCE = new IastMetric('instrumented.source', Scope.GLOBAL, TagKey.SOURCE_TYPE)
const INSTRUMENTED_SINK = new IastMetric('instrumented.sink', Scope.GLOBAL, TagKey.VULNERABILITY_TYPE)

const EXECUTED_SOURCE = new IastMetric('executed.source', Scope.REQUEST, TagKey.SOURCE_TYPE)
const EXECUTED_SINK = new IastMetric('executed.sink', Scope.REQUEST, TagKey.VULNERABILITY_TYPE)

const REQUEST_TAINTED = new NoTaggedIastMetric('request.tainted', Scope.REQUEST)

// DEBUG using metrics
const EXECUTED_PROPAGATION = new NoTaggedIastMetric('executed.propagation', Scope.REQUEST)
const EXECUTED_TAINTED = new NoTaggedIastMetric('executed.tainted', Scope.REQUEST)

// DEBUG using distribution endpoint
const INSTRUMENTATION_TIME = new NoTaggedIastMetric('instrumentation.time', Scope.GLOBAL)

module.exports = {
  INSTRUMENTED_PROPAGATION,
  INSTRUMENTED_SOURCE,
  INSTRUMENTED_SINK,

  EXECUTED_PROPAGATION,
  EXECUTED_SOURCE,
  EXECUTED_SINK,
  EXECUTED_TAINTED,

  REQUEST_TAINTED,

  INSTRUMENTATION_TIME,

  PropagationType,
  TagKey,

  IastMetric,

  getExecutedMetric,
  getInstrumentedMetric,

  formatTags
}
