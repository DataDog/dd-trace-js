'use strict'

const { AbortController } = require('node-abort-controller') // AbortController is not available in node <15
const shimmer = require('../../datadog-shimmer')
const { channel, addHook, AsyncResource } = require('./helpers/instrument')

const bodyParserReadCh = channel('datadog:body-parser:read:finish')

function publishRequestBodyAndNext (req, res, next) {
  return function () {
    if (bodyParserReadCh.hasSubscribers && req) {
      const abortController = new AbortController()
      bodyParserReadCh.publish({ req, res, abortController })
      if (abortController.signal.aborted) {
        res.end()
        return
      }
    }
    next.apply(this, arguments)
  }
}

addHook({
  name: 'body-parser',
  file: 'lib/read.js',
  versions: ['>=1.4.0']
}, read => {
  return shimmer.wrap(read, function (req, res, next) {
    const nextResource = new AsyncResource('bound-anonymous-fn')
    arguments[2] = nextResource.bind(publishRequestBodyAndNext(req, res, next))
    read.apply(this, arguments)
  })
})
