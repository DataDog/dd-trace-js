'use strict'

const Sampler = require('./sampler')

// TODO: replace these with global constants
const SERVICE_NAME = 'service.name'
const SAMPLING_PRIORITY = 'sampling.priority'
const DEFAULT_KEY = 'service:,env:'

class PrioritySampler {
  constructor (env) {
    this._env = env
    this.update({})
  }

  isSampled (span) {
    const context = this._getContext(span)
    const key = `service:${context.tags[SERVICE_NAME]},env:${this._env}`
    const sampler = this._samplers[key] || this._samplers[DEFAULT_KEY]

    return sampler.isSampled(span)
  }

  sample (span) {
    const context = this._getContext(span)

    if (context.sampling.priority !== undefined) return

    const tag = parseInt(context.tags[SAMPLING_PRIORITY], 10)

    if (this.validate(tag)) {
      context.sampling.priority = tag
      return
    }

    context.sampling.priority = this.isSampled(span) ? 1 : 0
  }

  update (rates) {
    const samplers = {}

    for (const key in rates) {
      const rate = rates[key]
      const sampler = new Sampler(rate)

      samplers[key] = sampler
    }

    samplers[DEFAULT_KEY] = samplers[DEFAULT_KEY] || new Sampler(1)

    this._samplers = samplers
  }

  validate (samplingPriority) {
    return [-1, 0, 1, 2].indexOf(samplingPriority) !== -1
  }

  _getContext (span) {
    return typeof span.context === 'function' ? span.context() : span
  }
}

module.exports = PrioritySampler
