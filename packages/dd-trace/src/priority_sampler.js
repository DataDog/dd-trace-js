'use strict'

const Sampler = require('./sampler')
const ext = require('../../../ext')

const SERVICE_NAME = ext.tags.SERVICE_NAME
const SAMPLING_PRIORITY = ext.tags.SAMPLING_PRIORITY
const MANUAL_KEEP = ext.tags.MANUAL_KEEP
const MANUAL_DROP = ext.tags.MANUAL_DROP
const USER_REJECT = ext.priority.USER_REJECT
const AUTO_REJECT = ext.priority.AUTO_REJECT
const AUTO_KEEP = ext.priority.AUTO_KEEP
const USER_KEEP = ext.priority.USER_KEEP
const DEFAULT_KEY = 'service:,env:'

const priorities = new Set([
  USER_REJECT,
  AUTO_REJECT,
  AUTO_KEEP,
  USER_KEEP
])

class PrioritySampler {
  constructor (env) {
    this._env = env
    this.update({})
  }

  isSampled (span) {
    const context = this._getContext(span)
    const key = `service:${context._tags[SERVICE_NAME]},env:${this._env}`
    const sampler = this._samplers[key] || this._samplers[DEFAULT_KEY]

    return sampler.isSampled(span)
  }

  sample (span) {
    const context = this._getContext(span)

    if (context._sampling.priority !== undefined) return

    const tag = this._getPriority(context._tags)

    if (this.validate(tag)) {
      context._sampling.priority = tag
      return
    }

    context._sampling.priority = this.isSampled(span) ? AUTO_KEEP : AUTO_REJECT
  }

  update (rates) {
    const samplers = {}

    for (const key in rates) {
      const rate = rates[key]
      const sampler = new Sampler(rate)

      samplers[key] = sampler
    }

    samplers[DEFAULT_KEY] = samplers[DEFAULT_KEY] || new Sampler(AUTO_KEEP)

    this._samplers = samplers
  }

  validate (samplingPriority) {
    return priorities.has(samplingPriority)
  }

  _getContext (span) {
    return typeof span.context === 'function' ? span.context() : span
  }

  _getPriority (tags) {
    if (tags.hasOwnProperty(MANUAL_KEEP) && tags[MANUAL_KEEP] !== false) {
      return USER_KEEP
    } else if (tags.hasOwnProperty(MANUAL_DROP) && tags[MANUAL_DROP] !== false) {
      return USER_REJECT
    } else {
      const priority = parseInt(tags[SAMPLING_PRIORITY], 10)

      if (priority === 1 || priority === 2) {
        return USER_KEEP
      } else if (priority === 0 || priority === -1) {
        return USER_REJECT
      }
    }
  }
}

module.exports = PrioritySampler
