'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const routerHandler = require('./router')

const startCh = channel('apm:express:request:start')
const finish = channel('apm:express:request:finish')
const errorCh = channel('apm:express:request:error')

addHook({ name: 'express', versions: ['>=4'] }, express => {
  routerHandler(express.Router)

  shimmer.wrap(express.response, 'emit', wrapResponseEmit)

  shimmer.wrap(express.application, 'handle', handle => function (req, res) {
    if (!startCh.hasSubscribers) {
      return handle.apply(this, arguments)
    }
    res.req = req
    const asyncResource = new AsyncResource('bound-anonymous-fn')

    return asyncResource.runInAsyncScope(() => {
      startCh.publish({ req, res, asyncResource })

      try {
        return handle.apply(this, arguments)
      } catch (err) {
        errorCh.publish(err)

        throw err
      }
    })
  })
  return express
})

function wrapResponseEmit (emit) {
  return function () {
    if (!startCh.hasSubscribers) {
      return emit.apply(this, arguments)
    }

    if (arguments[0] === 'finish') {
      finish.publish({ req: this.req })
    }

    return emit.apply(this, arguments)
  }
}
