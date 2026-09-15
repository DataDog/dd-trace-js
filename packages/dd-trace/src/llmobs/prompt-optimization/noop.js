'use strict'

const { OptimizationResult } = require('./result')

// Returned by NoopExperiments.optimizePrompt() when experiments are unavailable:
// run() resolves immediately with the initial prompt and no iterations.
class NoopPromptOptimization {
  #initialPrompt

  constructor (options = {}) {
    this.name = options.name ?? ''
    this.#initialPrompt = typeof options.config?.prompt === 'string' ? options.config.prompt : ''
  }

  run () {
    return Promise.resolve(new OptimizationResult(this.name, this.#initialPrompt, [], 0))
  }
}

module.exports = { NoopPromptOptimization }
