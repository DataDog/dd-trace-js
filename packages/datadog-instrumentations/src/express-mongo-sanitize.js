'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')

const sanitizeMethodFinished = channel('datadog:express-mongo-sanitize:sanitize:finish')
const sanitizeMiddlewareFinished = channel('datadog:express-mongo-sanitize:filter:finish')

const propertiesToSanitize = ['body', 'params', 'headers', 'query']

addHook({ name: 'express-mongo-sanitize', versions: ['>=1.0.0'] }, expressMongoSanitize => {
  shimmer.wrap(expressMongoSanitize, 'sanitize', sanitize => function (...args) {
    const sanitizedObject = sanitize.apply(this, args)

    if (sanitizeMethodFinished.hasSubscribers) {
      sanitizeMethodFinished.publish({ sanitizedObject })
    }

    return sanitizedObject
  })

  return shimmer.wrapFunction(expressMongoSanitize, expressMongoSanitize => function (...args) {
    const middleware = expressMongoSanitize.apply(this, args)

    return shimmer.wrapFunction(middleware, middleware => function (...args) {
      if (!sanitizeMiddlewareFinished.hasSubscribers) {
        return Reflect.apply(middleware, this, args)
      }

      const req = args[0]
      // Mirror next's name/arity so wrapCallback skips its per-call identity rewrite.
      const wrappedNext = shimmer.wrapCallback(args[2], original => function next (_error) {
        sanitizeMiddlewareFinished.publish({
          sanitizedProperties: propertiesToSanitize,
          req,
        })

        return original.apply(this, arguments)
      })

      return middleware.call(this, req, args[1], wrappedNext)
    })
  })
})
