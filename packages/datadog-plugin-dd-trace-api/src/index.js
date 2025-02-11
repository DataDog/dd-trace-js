'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const telemetryMetrics = require('../../dd-trace/src/telemetry/metrics')
const apiMetrics = telemetryMetrics.manager.namespace('tracers')

// api ==> here
const objectMap = new WeakMap()

const injectionEnabledTag =
  `injection_enabled:${process.env.DD_INJECTION_ENABLED ? 'yes' : 'no'}`

module.exports = class DdTraceApiPlugin extends Plugin {
  static get id () {
    return 'dd-trace-api'
  }

  constructor (...args) {
    super(...args)

    const tracer = this._tracer

    this.addSub('datadog-api:v1:tracerinit', ({ proxy }) => {
      const proxyVal = proxy()
      objectMap.set(proxyVal, tracer)
      objectMap.set(proxyVal.appsec, tracer.appsec)
      objectMap.set(proxyVal.dogstatsd, tracer.dogstatsd)
    })

    const handleEvent = (name) => {
      const counter = apiMetrics.count('dd_trace_api.called', [
        `name:${name.replaceAll(':', '.')}`,
        'api_version:v1',
        injectionEnabledTag
      ])

      // For v1, APIs are 1:1 with their internal equivalents, so we can just
      // call the internal method directly. That's what we do here unless we
      // want to override. As the API evolves, this may change.
      this.addSub(`datadog-api:v1:${name}`, ({ self, args, ret, proxy, revProxy }) => {
        counter.inc()

        if (name.includes(':')) {
          name = name.split(':').pop()
        }

        if (objectMap.has(self)) {
          self = objectMap.get(self)
        }

        // `trace` returns the value that's returned from the original callback
        // passed to it, so we need to detect that happening and bypass the check
        // for a proxy, since a proxy isn't needed, since the object originates
        // from the caller. In callbacks, we'll assign return values to this
        // value, and bypass the proxy check if `ret.value` is exactly this
        // value.
        let passthroughRetVal

        for (let i = 0; i < args.length; i++) {
          if (objectMap.has(args[i])) {
            args[i] = objectMap.get(args[i])
          }
          if (typeof args[i] === 'function') {
            const orig = args[i]
            args[i] = (...fnArgs) => {
              for (let j = 0; j < fnArgs.length; j++) {
                if (revProxy && revProxy[j]) {
                  const proxyVal = revProxy[j]()
                  objectMap.set(proxyVal, fnArgs[j])
                  fnArgs[j] = proxyVal
                }
              }
              // TODO do we need to apply(this, ...) here?
              passthroughRetVal = orig(...fnArgs)
              return passthroughRetVal
            }
          }
        }

        try {
          ret.value = self[name](...args)
          if (proxy) {
            const proxyVal = proxy()
            objectMap.set(proxyVal, ret.value)
            ret.value = proxyVal
          } else if (ret.value && typeof ret.value === 'object' && passthroughRetVal !== ret.value) {
            if (typeof ret.value.then === 'function') {
              return Promise.all([ret.value, passthroughRetVal]).then(([value, passthroughRetVal]) => {
                if (value !== passthroughRetVal) {
                  // TODO(bengl) creating all these promises isn't great. Maybe we should only enable
                  // this in test/debug mode?
                  throw new TypeError(`Objects need proxies when returned via API (${name})`)
                }
              })
            } else {
              throw new TypeError(`Objects need proxies when returned via API (${name})`)
            }
          }
        } catch (e) {
          ret.error = e
        }
      })
    }

    // handleEvent('configure')
    handleEvent('startSpan')
    handleEvent('wrap')
    handleEvent('trace')
    handleEvent('inject')
    handleEvent('extract')
    handleEvent('getRumData')
    handleEvent('profilerStarted')
    handleEvent('context:toTraceId')
    handleEvent('context:toSpanId')
    handleEvent('context:toTraceparent')
    handleEvent('span:context')
    handleEvent('span:setTag')
    handleEvent('span:addTags')
    handleEvent('span:finish')
    handleEvent('span:addLink')
    handleEvent('scope')
    handleEvent('scope:activate')
    handleEvent('scope:active')
    handleEvent('scope:bind')
    handleEvent('appsec:blockRequest')
    handleEvent('appsec:isUserBlocked')
    handleEvent('appsec:setUser')
    handleEvent('appsec:trackCustomEvent')
    handleEvent('appsec:trackUserLoginFailureEvent')
    handleEvent('appsec:trackUserLoginSuccessEvent')
    handleEvent('dogstatsd:decrement')
    handleEvent('dogstatsd:distribution')
    handleEvent('dogstatsd:flush')
    handleEvent('dogstatsd:gauge')
    handleEvent('dogstatsd:histogram')
    handleEvent('dogstatsd:increment')
    handleEvent('use')
  }
}
