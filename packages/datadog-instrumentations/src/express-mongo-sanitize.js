'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const sanitizeMethodFinished = channel('datadog:express-mongo-sanitize:sanitize:finish')
const sanitizeMiddlewareFinished = channel('datadog:express-mongo-sanitize:filter:finish')

const propertiesToSanitize = ['body', 'params', 'headers', 'query']

addHook({ name: 'express-mongo-sanitize', versions: ['>=1.0.0'] }, expressMongoSanitize => {
  shimmer.wrap(expressMongoSanitize, 'sanitize', sanitize => function () {
    const sanitizedObject = Reflect.apply(sanitize, this, arguments)

    if (sanitizeMethodFinished.hasSubscribers) {
      sanitizeMethodFinished.publish({ sanitizedObject })
    }

    return sanitizedObject
  })

  return shimmer.wrapFunction(expressMongoSanitize, expressMongoSanitize => function () {
    const middleware = Reflect.apply(expressMongoSanitize, this, arguments)

    return shimmer.wrapFunction(middleware, middleware => function (req, res, next) {
      if (!sanitizeMiddlewareFinished.hasSubscribers) {
        return Reflect.apply(middleware, this, arguments)
      }

      const wrappedNext = shimmer.wrapFunction(next, next => function () {
        sanitizeMiddlewareFinished.publish({
          sanitizedProperties: propertiesToSanitize,
          req
        })

        return Reflect.apply(next, this, arguments)
      })

      return middleware.call(this, req, res, wrappedNext)
    })
  })
})
