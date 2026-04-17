'use strict'

const NoopTracer = require('../../dd-trace/src/noop/tracer')
const Plugin = require('../../dd-trace/src/plugins/plugin')

/**
 * Cypress plugin handles setup-node-events from the instrumentation layer
 * via a diagnostic channel, keeping the instrumentation free of tracer references.
 */
class CypressPlugin extends Plugin {
  static id = 'cypress'

  constructor (...args) {
    super(...args)

    this.addSub('ci:cypress:setup-node-events', (payload) => {
      // Bail out if the tracer failed to init (e.g. invalid DD_SITE).
      // Mirrors the guard in the manual plugin entrypoint (plugin.js).
      if (this._tracer._tracer instanceof NoopTracer) return

      const { on, config, userAfterSpecHandlers, userAfterRunHandlers, cleanupWrapper } = payload

      const registerAfterRunWithCleanup = (afterRunHandler) => {
        on('after:run', (results) => {
          const chain = userAfterRunHandlers.reduce(
            (p, h) => p.then(() => h(results)),
            Promise.resolve()
          )
          if (afterRunHandler) {
            return chain.then(() => afterRunHandler(results)).finally(cleanupWrapper)
          }
          return chain.finally(cleanupWrapper)
        })
      }

      const cypressPlugin = require('./cypress-plugin')

      if (cypressPlugin._isInit) {
        // Already initialized by manual plugin call — just chain user handlers
        for (const h of userAfterSpecHandlers) on('after:spec', h)
        registerAfterRunWithCleanup()
        payload.registered = true
        return
      }

      on('before:run', cypressPlugin.beforeRun.bind(cypressPlugin))

      on('after:spec', (spec, results) => {
        const chain = userAfterSpecHandlers.reduce(
          (p, h) => p.then(() => h(spec, results)),
          Promise.resolve()
        )
        return chain.then(() => cypressPlugin.afterSpec(spec, results))
      })

      registerAfterRunWithCleanup((results) => cypressPlugin.afterRun(results))

      on('task', cypressPlugin.getTasks())

      payload.registered = true
      // cypressPlugin.init expects the proxy tracer (with ._tracer._exporter),
      // not the unwrapped internal tracer that this.tracer returns.
      payload.configPromise = Promise.resolve(cypressPlugin.init(this._tracer, config)).then(() => config)
    })
  }
}

module.exports = CypressPlugin
