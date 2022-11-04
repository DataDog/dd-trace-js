'use strict'

const Tracer = require('./opentracing/tracer')
const tags = require('../../../ext/tags')
const Scope = require('./scope')
const { storage } = require('../../datadog-core')
const { isError } = require('./util')
const { setStartupLogConfig } = require('./startup-log')
const { channel } = require('../../datadog-instrumentations/src/helpers/instrument')


const SPAN_TYPE = tags.SPAN_TYPE
const RESOURCE_NAME = tags.RESOURCE_NAME
const SERVICE_NAME = tags.SERVICE_NAME
const MEASURED = tags.MEASURED

class DatadogTracer extends Tracer {
  constructor (config) {
    super(config)

    this._scope = new Scope()
    setStartupLogConfig(config)
  }

  trace (name, options, fn) {
    options = Object.assign({
      childOf: this.scope().active()
    }, options)
    if (!options.childOf && options.orphanable === false) {
      return fn(null, () => {})
    }

    const span = this.startSpan(name, options)

    addTags(span, options)

    try {
      if (fn.length > 1) {
        return this.scope().activate(span, () => fn(span, err => {
          addError(span, err)
          span.finish()
        }))
      }

      const result = this.scope().activate(span, () => fn(span))
      const dc = channel('_ddtrace:tracer:killSpan')
      // kill spans
      dc.subscribe(_ => {
        this.crashFlush()
      })
      
      /* const result = this.scope().activate(span, () => {
        if (this.___lambdaContext) {
          const timeout = this.___lambdaContext.getRemainingTimeInMillis()
          setTimeout(() => {
            this.crashFlush()
          }, timeout)
        }
        return fn(span)
      })  */
      if (result && typeof result.then === 'function') {
        return result.then(
          value => {
            span.finish()
            return value
          },
          err => {
            addError(span, err)
            span.finish()
            throw err
          }
        )
      } else {
        span.finish()
      }

      return result
    } catch (e) {
      addError(span, e)
      span.finish()
      throw e
    }
  }

  crashFlush() {
    console.log('SETTING KILLALL IN MAIN TRACER')
    const active = this.scope().active()
    const err = new Error('Datadog detected an impending timeout')
    addError(active, err)
    active.setTag('error', 1)
    this._processor.killAll()
    console.log('active scope tags', active._spanContext._tags)
    active.finish()
  }

  wrap (name, options, fn) {
    const tracer = this

    return function () {
      const store = storage.getStore()

      if (store && store.noop) return fn.apply(this, arguments)

      let optionsObj = options
      if (typeof optionsObj === 'function' && typeof fn === 'function') {
        optionsObj = optionsObj.apply(this, arguments)
      }

      if (optionsObj && optionsObj.orphanable === false && !tracer.scope().active()) {
        return fn.apply(this, arguments)
      }

      const lastArgId = arguments.length - 1
      const cb = arguments[lastArgId]

      if (typeof cb === 'function') {
        const scopeBoundCb = tracer.scope().bind(cb)
        return tracer.trace(name, optionsObj, (span, done) => {
          arguments[lastArgId] = function (err) {
            done(err)
            return scopeBoundCb.apply(this, arguments)
          }

          return fn.apply(this, arguments)
        })
      } else {
        return tracer.trace(name, optionsObj, () => fn.apply(this, arguments))
      }
    }
  }

  setUrl (url) {
    this._exporter.setUrl(url)
  }

  scope () {
    return this._scope
  }

  getRumData () {
    if (!this._enableGetRumData) {
      return ''
    }
    const span = this.scope().active().context()
    const traceId = span.toTraceId()
    const traceTime = Date.now()
    return `\
<meta name="dd-trace-id" content="${traceId}" />\
<meta name="dd-trace-time" content="${traceTime}" />`
  }

  setUser (user) {
    if (!user || !user.id) return this

    const span = this.scope().active()
    if (!span) return this

    const rootSpan = span._spanContext._trace.started[0]
    if (!rootSpan) return this

    for (const k of Object.keys(user)) {
      rootSpan.setTag(`usr.${k}`, '' + user[k])
    }

    return this
  }
}

function addError (span, error) {
  if (isError(error)) {
    span.addTags({
      'error.type': error.name,
      'error.msg': error.message,
      'error.stack': error.stack
    })
  }
}

function addTags (span, options) {
  const tags = {}

  if (options.type) tags[SPAN_TYPE] = options.type
  if (options.service) tags[SERVICE_NAME] = options.service
  if (options.resource) tags[RESOURCE_NAME] = options.resource

  tags[MEASURED] = options.measured

  span.addTags(tags)
}

module.exports = DatadogTracer
