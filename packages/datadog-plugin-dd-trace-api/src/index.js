'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')

// api ==> here
const objectMap = new WeakMap()

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
    })

    const handleEvent = (name) => {
      // For v1, APIs are 1:1 with their internal equivalents, so we can just
      // call the internal method directly. That's what we do here unless we
      // want to override. As the API evolves, this may change.
      this.addSub(`datadog-api:v1:${name}`, ({ self, args, ret, proxy, revProxy }) => {
        if (name.includes(':')) {
          name = name.split(':').pop()
        }

        if (objectMap.has(self)) {
          self = objectMap.get(self)
        }

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
              return orig(...fnArgs)
            }
          }
        }

        try {
          ret.value = self[name](...args)
          if (proxy) {
            const proxyVal = proxy()
            objectMap.set(proxyVal, ret.value)
            ret.value = proxyVal
          }
        } catch (e) {
          ret.error = e
        }
      })
    }

    handleEvent('init')
    // TODO(bengl) for API calls like this one that return an object created
    // internally, care needs to be taken to ensure we're not breaking the
    // calling API. We don't expect spans to change much, but if they do, this
    // needs to be taken into account.
    handleEvent('startSpan')
    handleEvent('wrap')
    handleEvent('trace')
    handleEvent('inject')
    handleEvent('extract')
    handleEvent('getRumData')
    handleEvent('setUser')
    handleEvent('profilerStarted')
    handleEvent('span:context')
    handleEvent('span:setTag')
    handleEvent('span:addTags')
    handleEvent('span:finish')
    handleEvent('span:addLink')
  }
}
