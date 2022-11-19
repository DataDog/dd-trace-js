'use strict'

require('../../dd-trace/test/setup/tap')

require('../src/q')

const assertPromise = require('./helpers/promise')

assertPromise('q', Q => {
  return function Promise (executor) {
    const deferred = Q.defer()

    executor(deferred.resolve, deferred.reject)

    return deferred.promise
  }
})
