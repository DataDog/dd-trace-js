'use strict'

const { addValue } = require('./telemetry-collector')

const Scope = {
  GLOBAL: 'GLOBAL',
  REQUEST: 'REQUEST'
}

class Metric {
  constructor (name, scope, metricTag, namespace) {
    this.name = name
    this.common = true
    this.type = 'count'
    this.metricTag = metricTag
    this.scope = scope
    this.namespace = namespace || 'appsec'
  }

  hasRequestScope () {
    return this.scope === Scope.REQUEST
  }

  getTags (tag) {
    return this.metricTag && tag ? [`${this.metricTag}:${tag}`] : undefined
  }

  increase (tag, context) {
    this.add(1, tag, context)
  }

  add (value, tag, context) {
    if (Array.isArray(tag)) {
      tag.forEach(t => addValue(this, value, t, context))
    } else {
      addValue(this, value, tag, context)
    }
  }
}

module.exports = {
  Metric,
  Scope
}
