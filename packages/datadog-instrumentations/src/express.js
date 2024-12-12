'use strict'

const { createWrapRouterMethod } = require('./router')
const shimmer = require('../../datadog-shimmer')
const { addHook, channel } = require('./helpers/instrument')
const tracingChannel = require('dc-polyfill').tracingChannel

const handleChannel = channel('apm:express:request:handle')

function wrapHandle (handle) {
  return function handleWithTrace (req, res) {
    if (handleChannel.hasSubscribers) {
      handleChannel.publish({ req })
    }

    return handle.apply(this, arguments)
  }
}

const wrapRouterMethod = createWrapRouterMethod('express')

const responseJsonChannel = channel('datadog:express:response:json:start')

function wrapResponseJson (json) {
  return function wrappedJson (obj) {
    if (responseJsonChannel.hasSubscribers) {
      // backward compat as express 4.x supports deprecated 3.x signature
      if (arguments.length === 2 && typeof arguments[1] !== 'number') {
        obj = arguments[1]
      }

      responseJsonChannel.publish({ req: this.req, res: this, body: obj })
    }

    return json.apply(this, arguments)
  }
}

const responseRenderChannel = tracingChannel('datadog:express:response:render')

function wrapResponseRender (render) {
  return function wrappedRender (view, options, callback) {
    if (!responseRenderChannel.start.hasSubscribers) {
      return render.apply(this, arguments)
    }

    return responseRenderChannel.traceSync(
      render,
      {
        req: this.req,
        view,
        options
      },
      this,
      ...arguments
    )
  }
}

addHook({ name: 'express', versions: ['>=4'] }, express => {
  shimmer.wrap(express.application, 'handle', wrapHandle)

  shimmer.wrap(express.response, 'json', wrapResponseJson)
  shimmer.wrap(express.response, 'jsonp', wrapResponseJson)
  shimmer.wrap(express.response, 'render', wrapResponseRender)

  return express
})

addHook({ name: 'express', versions: ['4'] }, express => {
  shimmer.wrap(express.Router, 'use', wrapRouterMethod)
  shimmer.wrap(express.Router, 'route', wrapRouterMethod)

  return express
})

addHook({ name: 'express', versions: ['>=5.0.0'] }, express => {
  shimmer.wrap(express.Router.prototype, 'use', wrapRouterMethod)
  shimmer.wrap(express.Router.prototype, 'route', wrapRouterMethod)

  return express
})

const queryParserReadCh = channel('datadog:query:read:finish')

function publishQueryParsedAndNext (req, res, next) {
  return shimmer.wrapFunction(next, next => function () {
    if (queryParserReadCh.hasSubscribers && req) {
      const abortController = new AbortController()
      const query = req.query

      queryParserReadCh.publish({ req, res, query, abortController })

      if (abortController.signal.aborted) return
    }

    return next.apply(this, arguments)
  })
}

addHook({
  name: 'express',
  versions: ['4'],
  file: 'lib/middleware/query.js'
}, query => {
  return shimmer.wrapFunction(query, query => function () {
    const queryMiddleware = query.apply(this, arguments)

    return shimmer.wrapFunction(queryMiddleware, queryMiddleware => function (req, res, next) {
      arguments[2] = publishQueryParsedAndNext(req, res, next)
      return queryMiddleware.apply(this, arguments)
    })
  })
})

const processParamsStartCh = channel('datadog:express:process_params:start')
function wrapProcessParamsMethod (requestPositionInArguments) {
  return function wrapProcessParams (original) {
    return function wrappedProcessParams () {
      if (processParamsStartCh.hasSubscribers) {
        const req = arguments[requestPositionInArguments]
        const abortController = new AbortController()

        processParamsStartCh.publish({
          req,
          res: req?.res,
          abortController,
          params: req?.params
        })

        if (abortController.signal.aborted) return
      }

      return original.apply(this, arguments)
    }
  }
}

addHook({ name: 'express', versions: ['>=4.0.0 <4.3.0'] }, express => {
  shimmer.wrap(express.Router, 'process_params', wrapProcessParamsMethod(1))
  return express
})

addHook({ name: 'express', versions: ['>=4.3.0 <5.0.0'] }, express => {
  shimmer.wrap(express.Router, 'process_params', wrapProcessParamsMethod(2))
  return express
})

const queryReadCh = channel('datadog:express:query:finish')

addHook({ name: 'express', file: ['lib/request.js'], versions: ['>=5.0.0'] }, request => {
  const requestDescriptor = Object.getOwnPropertyDescriptor(request, 'query')

  shimmer.wrap(requestDescriptor, 'get', function (originalGet) {
    return function wrappedGet () {
      const query = originalGet.apply(this, arguments)

      if (queryReadCh.hasSubscribers && query) {
        queryReadCh.publish({ query })
      }

      return query
    }
  })

  Object.defineProperty(request, 'query', requestDescriptor)

  return request
})
