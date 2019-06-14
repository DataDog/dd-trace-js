'use strict'

const assertPromise = require('../../dd-trace/test/plugins/promise')

assertPromise('q', Q => {
  return function Promise (executor) {
    const deferred = Q.defer()

    executor(deferred.resolve, deferred.reject)

    return deferred.promise
  }
})
