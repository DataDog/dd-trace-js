'use strict'

const tags = require('../../../ext/tags')

function addError (span, error) {
  span.addTags({
    'error.type': error.name,
    'error.msg': error.message,
    'error.stack': error.stack
  })

  return error
}

function makeServiceName ({ serviceName = 'decorated-span' }) {
  return `${tags.SERVICE_NAME}-${serviceName}`
}

function makeResourceName ({ resourceName, className, methodName }) {
  if (resourceName) { return resourceName }
  if (className) { return `${className}.${methodName}` }

  return methodName
}

function makeTags (config) {
  const serviceName = makeServiceName(config)
  const resourceName = makeResourceName(config)

  return {
    [tags.SERVICE_NAME]: serviceName,
    [tags.RESOURCE_NAME]: resourceName,
    [tags.ANALYTICS]: config.appAnalytics,
    ...config.tags
  }
}

/**
 *
 * The initial trace call figures out if it is wrapping a class or a method.
 * If a class, it then traces each method of that class.
 *
 *   +---------------+
 *   |               |
 *   | @trace()      |
 *   |               +----+
 *   +--+------------+    |
 *      |                 v
 *      |              +--+-------------+
 *      |              |                |
 *      |              | _traceClass    |
 *      |              |                |
 *      |              +--+---+---------+
 *      v                 |   |
 *   +--+-------------+   |   |
 *   |                +<--+   |
 *   | _traceMethod   |       |
 *   |                +<------+
 *   +--+-------------+
 *      |
 *      v
 *   +--+-------------+
 *   |                |
 *   | _traceFunction |
 *   |                |
 *   +----------------+
 *
 */

class Decorator {
  constructor (tracer) {
    this._tracer = tracer
  }

  trace (config) {
    function traceDecorator (a, b, c) {
      if (typeof a === 'function') {
        this._traceClass(config, a)
      } else {
        this._traceMethod(config, a, b, c)
      }
    }

    return traceDecorator.bind(this)
  }

  _traceClass (config, constructor) {
    const keys = Reflect.ownKeys(constructor.prototype)

    keys.forEach(key => {
      if (key === 'constructor') {
        return
      }

      const descriptor = Object.getOwnPropertyDescriptor(
        constructor.prototype,
        key
      )

      if (typeof key === 'string' && descriptor && typeof descriptor.value === 'function') {
        Object.defineProperty(
          constructor.prototype,
          key,
          this._traceMethod(config, constructor, key, descriptor)
        )
      }
    })
  }

  _traceMethod (config, target, propertyKey, descriptor) {
    const wrappedFn = descriptor.value

    if (wrappedFn) {
      // target.name is needed if the target is the constructor itself
      const className = target.name || target.constructor.name
      const methodName = wrappedFn.name
      descriptor.value = this._traceFunction({ ...config, className, methodName }, wrappedFn)
    }

    return descriptor
  }

  _traceFunction (config, target) {
    // The tracer needs to be caputured in a closure as the wrapper function's "this"
    // will be from the caller, not from this class
    const tracer = this._tracer

    function wrapperFn (...args) {
      const tags = makeTags(config)
      const childOf = tracer.scope().active() || undefined
      const spanName = config.spanName || 'DECORATED_SPAN'
      const spanOptions = { childOf, tags }
      const span = tracer.startSpan(spanName, spanOptions)

      // The callback fn needs to be wrapped in an arrow fn as the activate fn clobbers `this`
      return tracer.scope().activate(span, () => {
        const output = target.call(this, ...args)

        if (output && typeof output.then === 'function') {
          output
            .catch((error) => {
              addError(span, error)
            })
            .finally(() => {
              span.finish()
            })
        } else {
          span.finish()
        }

        return output
      })
    }

    return wrapperFn
  }
}

module.exports = Decorator
