'use strict'

const Tracer = require('./opentracing/tracer')
const tags = require('../../../ext/tags')
const Scope = require('./scope')
const { storage } = require('../../datadog-core')
const { isError } = require('./util')
const { setStartupLogConfig } = require('./startup-log')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')

const SPAN_TYPE = tags.SPAN_TYPE
const RESOURCE_NAME = tags.RESOURCE_NAME
const SERVICE_NAME = tags.SERVICE_NAME
const MEASURED = tags.MEASURED

class DatadogTracer extends Tracer {
  constructor (config) {
    super(config)

    this._scope = new Scope()
    setStartupLogConfig(config)
    startMiniAgent()
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
}

function addError (span, error) {
  if (isError(error)) {
    span.addTags({
      [ERROR_TYPE]: error.name,
      [ERROR_MESSAGE]: error.message,
      [ERROR_STACK]: error.stack
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

function startMiniAgent () {
  const fs = require('fs');
  fs.appendFileSync('/tmp/dd-trace-js-logs.txt', 'Attempting to start mini agent...');

  try {
    const addonName = "./libsidecar-node.linux-x64-gnu.node"
    const napiStartMiniAgent = require(addonName).napiStartMiniAgent

    // const { fork } = require('child_process');
    // const options = {
    //   slient:true,
    //   detached:true,
    //     stdio: [null, null, null, 'ipc']
    // };

    // const handle = fork('./test_child.js', {
    //   detached: true,
    //   stdio: 'ignore'
    // });

    napiStartMiniAgent()

    var process = require('process');

    fs.appendFileSync('/tmp/dd-trace-js-logs.txt', "cur PID after napi_start: " + process.pid);

    child_process.exec("ps aux", (err, stdout, stdin) => {
        if (err) throw err;
        fs.appendFileSync('/tmp/dd-trace-js-logs.txt', "processes after napiStartMiniAgent: " + stdout);
    });

  } catch (e) {
    fs.appendFileSync('/tmp/dd-trace-js-logs.txt', 'encountered an error when starting mini agent: ' + e);
  }
}

module.exports = DatadogTracer
