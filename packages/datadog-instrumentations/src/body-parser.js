'use strict'

const { channel, addHook } = require('./helpers/instrument')

const bodyParserReadCh = channel('datadog:body-parser:read:start')

function publishRequestBodyAndNext (request, next) {
  return function () {
    if (bodyParserReadCh.hasSubscribers && request) {
      bodyParserReadCh.publish({ request })
    }
    next.apply(this, arguments)
  }
}

addHook({
  name: 'body-parser',
  file: 'lib/read.js',
  versions: ['>=1']
}, read => {
  return function (req, res, next) {
    arguments[2] = publishRequestBodyAndNext(req, next)
    read.apply(this, arguments)
  }
})
