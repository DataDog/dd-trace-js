'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')

const bodyParserReadCh = channel('datadog:body-parser:read:finish')

function publishRequestBodyAndNext (req, res, next) {
  return function () {
    if (bodyParserReadCh.hasSubscribers && req) {
      const abortController = new AbortController()
      const body = req.body

      bodyParserReadCh.publish({ req, res, body, abortController })

      if (abortController.signal.aborted) return
    }

    return next.apply(this, arguments)
  }
}

addHook({
  name: 'body-parser',
  file: 'lib/read.js',
  versions: ['>=1.4.0']
}, read => {
  return shimmer.wrap(read, function (req, res, next) {
    arguments[2] = publishRequestBodyAndNext(req, res, next)
    return read.apply(this, arguments)
  })
})
