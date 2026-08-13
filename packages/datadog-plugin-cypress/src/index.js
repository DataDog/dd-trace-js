'use strict'

const NoopTracer = require('../../dd-trace/src/noop/tracer')
const Plugin = require('../../dd-trace/src/plugins/plugin')
const log = require('../../dd-trace/src/log')

/**
 * Runs the Datadog finalizer even when a user Cypress handler fails, while
 * preserving the user's error as the framework-visible failure.
 *
 * @param {Promise<void>} userHandlers
 * @param {(userError?: unknown) => unknown} finalizer
 * @returns {Promise<unknown>}
 */
function finalizeAfterUserHandlers (userHandlers, finalizer) {
  return userHandlers.then(
    () => finalizer(),
    userError => Promise.resolve().then(() => {
      const finalizerError = userError || new Error('Cypress user handler rejected without an error')
      return finalizer(finalizerError)
    }).then(
      () => { throw userError },
      finalizerError => {
        log.error('Datadog Cypress finalizer failed after a user handler error', finalizerError)
        throw userError
      }
    )
  )
}

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

      const {
        on,
        config,
        userAfterSpecHandlers,
        userAfterRunHandlers,
        userAfterScreenshotHandlers,
        cleanupWrapper,
      } = payload

      const registerAfterRunWithCleanup = (afterRunHandler) => {
        on('after:run', (results) => {
          const chain = userAfterRunHandlers.reduce(
            (p, h) => p.then(() => h(results)),
            Promise.resolve()
          )
          if (afterRunHandler) {
            return finalizeAfterUserHandlers(chain, userError => afterRunHandler(results, userError))
              .finally(cleanupWrapper)
          }
          return chain.finally(cleanupWrapper)
        })
      }

      const cypressPlugin = require('./cypress-plugin')
      const datadogAfterScreenshotHandler = cypressPlugin.getAfterScreenshotHandler()

      // Cypress keeps a single after:screenshot handler, so registering the
      // plugin's would drop any user handler (e.g. one that moves/renames a
      // screenshot). Chain the user handler(s) first, threading the returned
      // { path, size, dimensions } forward — Cypress uses the final path for
      // downstream steps — then run the plugin's afterScreenshot on those
      // details and propagate the value back to Cypress. The user handler runs
      // regardless of whether screenshot upload is enabled.
      const registerAfterScreenshot = (afterScreenshotHandler) => {
        const filteredUserAfterScreenshotHandlers = userAfterScreenshotHandlers.filter(
          handler => handler !== afterScreenshotHandler
        )
        if (filteredUserAfterScreenshotHandlers.length === 0) {
          if (afterScreenshotHandler) on('after:screenshot', afterScreenshotHandler)
          return
        }

        on('after:screenshot', (details) => {
          const chain = filteredUserAfterScreenshotHandlers.reduce(
            (p, h) => p.then((latestDetails) => Promise.resolve(h(latestDetails)).then(
              // Merge the user handler's (possibly partial) return into the running details
              // rather than replacing them, so Cypress metadata such as `testFailure` and
              // `takenAt` survives a handler that only returns { path, size, dimensions }.
              (returned) => (returned == null ? latestDetails : { ...latestDetails, ...returned })
            )),
            Promise.resolve(details)
          )
          return chain.then((finalDetails) => {
            if (afterScreenshotHandler) afterScreenshotHandler(finalDetails)
            return finalDetails
          })
        })
      }

      if (cypressPlugin._isInit) {
        // Already initialized by manual plugin call — just chain user handlers.
        // Pass the plugin's afterScreenshot so chaining a user handler doesn't drop the upload
        // (the chained registration replaces the one plugin.js set, so it must include it).
        if (userAfterSpecHandlers.length > 0) {
          on('after:spec', (spec, results) => userAfterSpecHandlers.reduce(
            (chain, handler) => chain.then(() => handler(spec, results)),
            Promise.resolve()
          ))
        }
        registerAfterScreenshot(datadogAfterScreenshotHandler)
        registerAfterRunWithCleanup()
        payload.registered = true
        return
      }

      on('before:run', cypressPlugin.beforeRun.bind(cypressPlugin))
      registerAfterScreenshot(datadogAfterScreenshotHandler)

      on('after:spec', (spec, results) => {
        const chain = userAfterSpecHandlers.reduce(
          (p, h) => p.then(() => h(spec, results)),
          Promise.resolve()
        )
        return finalizeAfterUserHandlers(chain, userError => cypressPlugin.afterSpec(spec, results, userError))
          .catch((error) => {
            cleanupWrapper()
            throw error
          })
      })

      registerAfterRunWithCleanup((results, userError) => cypressPlugin.afterRun(results, userError))

      on('task', cypressPlugin.getTasks())

      payload.registered = true
      // cypressPlugin.init expects the proxy tracer (with ._tracer._exporter),
      // not the unwrapped internal tracer that this.tracer returns.
      payload.configPromise = Promise.resolve(cypressPlugin.init(this._tracer, config)).then(() => config)
    })
  }
}

module.exports = CypressPlugin
