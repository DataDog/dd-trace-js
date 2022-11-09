'use strict'

const { channel, addHook, AsyncResource } = require('./helpers/instrument')

const bodyParserReadCh = channel('datadog:body-parser:read:finish')

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
    const nextResource = new AsyncResource('bound-anonymous-fn')
    arguments[2] = nextResource.bind(publishRequestBodyAndNext(req, next))
    read.apply(this, arguments)
  }
})
