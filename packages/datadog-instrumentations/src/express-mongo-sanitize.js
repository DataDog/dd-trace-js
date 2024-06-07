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
    const sanitizedObject = sanitize.apply(this, arguments)

    if (sanitizeMethodFinished.hasSubscribers) {
      sanitizeMethodFinished.publish({ sanitizedObject })
    }

    return sanitizedObject
  })

  return shimmer.wrap(expressMongoSanitize, function () {
    const middleware = expressMongoSanitize.apply(this, arguments)

    return shimmer.wrap(middleware, function (req, res, next) {
      if (!sanitizeMiddlewareFinished.hasSubscribers) {
        return middleware.apply(this, arguments)
      }

      const wrappedNext = shimmer.wrap(next, function () {
        sanitizeMiddlewareFinished.publish({
          sanitizedProperties: propertiesToSanitize,
          req
        })

        return next.apply(this, arguments)
      })

      return middleware.call(this, req, res, wrappedNext)
    })
  })
})
