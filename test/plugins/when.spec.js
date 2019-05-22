'use strict'

const assertPromise = require('./promise')

assertPromise('when', when => {
  return function Promise (executor) {
    const deferred = when.defer()

    executor(deferred.resolve, deferred.reject)

    return deferred.promise
  }
})
