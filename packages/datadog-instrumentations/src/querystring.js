'use strict'

const { addHook, channel } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const names = ['querystring', 'node:querystring']

const querystringParseCh = channel('datadog:querystring:parse:finish')

addHook({ name: names }, function (querystring) {
  shimmer.wrap(querystring, 'parse', function (parse) {
    function wrappedMethod () {
      const qs = parse.apply(this, arguments)
      if (querystringParseCh.hasSubscribers && qs) {
        querystringParseCh.publish({ qs })
      }

      return qs
    }

    return wrappedMethod
  })
  return querystring
})
