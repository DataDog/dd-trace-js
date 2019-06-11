'use strict'

const assertPromise = require('../../dd-trace/test/plugins/promise')

assertPromise('when', when => {
  return function Promise (executor) {
    const deferred = when.defer()

    executor(deferred.resolve, deferred.reject)

    return deferred.promise
  }
})
