'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')

const objectMap = new WeakMap()

class DdTraceApiPlugin extends Plugin {
  static get id () {
    return 'dd-trace-api'
  }

  constructor (...args) {
    super(...args)

    const tracer = this._tracer

    const handleEvent = (name, fn) => {
      // For v1, APIs are 1:1 with their internal equivalents, so we can just
      // call the internal method directly. That's what we do here unless we
      // want to override. As the API evolves, this may change.
      this.addSub(`datadog-api:v1:${name}`, ({ self, args, ret, dummy }) => {
        if (!fn && name.includes(':')) {
          name = name.split(':').pop()
        }

        try {
          ret.value = fn ? fn(args, self) : self[name](...args)
          if (dummy) {
            objectMap.set(dummy, ret.value)
            ret.value = dummy
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
    handleEvent('inject')
    handleEvent('extract')
    handleEvent('getRumData')
    handleEvent('setUser')
    handleEvent('profilerStarted')
  }
}
