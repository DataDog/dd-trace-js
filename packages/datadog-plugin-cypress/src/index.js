'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const cypressPlugin = require('./cypress-plugin')

class CypressPlugin extends Plugin {
  static id = 'cypress'

  constructor (...args) {
    super(...args)

    this.addSub('ci:cypress:session:init', (ctx) => {
      if (cypressPlugin._isInit) {
        ctx.alreadyInit = true
        return
      }

      ctx.initPromise = cypressPlugin.init(this._tracer, ctx.config)
    })

    this.addSub('ci:cypress:before-run', ({ details, onDone }) => {
      cypressPlugin.beforeRun(details).then(onDone, onDone)
    })

    this.addSub('ci:cypress:after-spec', ({ spec, results, onDone }) => {
      Promise.resolve(cypressPlugin.afterSpec(spec, results)).then(onDone, onDone)
    })

    this.addSub('ci:cypress:after-run', ({ results, onDone }) => {
      Promise.resolve(cypressPlugin.afterRun(results)).then(onDone, onDone)
    })

    this.addSub('ci:cypress:get-tasks', (ctx) => {
      ctx.tasks = cypressPlugin.getTasks()
    })
  }
}

module.exports = CypressPlugin
