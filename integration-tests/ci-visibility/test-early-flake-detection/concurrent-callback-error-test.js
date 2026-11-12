'use strict'

let throwExecutions = 0
let returnExecutions = 0

test.concurrent('new concurrent done-callback test that throws on retries', (done) => {
  if (throwExecutions++ === 0) {
    done()
    return
  }

  throw new Error('concurrent done-callback retry throws')
})

test.concurrent('new concurrent done-callback test that returns on retries', (done) => {
  if (returnExecutions++ === 0) {
    done()
    return
  }

  return 'unexpected return value'
})
