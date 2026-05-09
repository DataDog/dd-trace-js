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

    return shimmer.wrapFunction(middleware, middleware => function (req, res, next) {
      if (!sanitizeMiddlewareFinished.hasSubscribers) {
        return middleware.apply(this, arguments)
      }

      const wrappedNext = shimmer.wrapFunction(next, next => function (...args) {
        sanitizeMiddlewareFinished.publish({
          sanitizedProperties: propertiesToSanitize,
          req,
        })

        return next.apply(this, args)
      })

      return middleware.call(this, req, res, wrappedNext)
    })
  })
})
