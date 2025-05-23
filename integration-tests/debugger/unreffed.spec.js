'use strict'

const { assert } = require('chai')
const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  const t = setup()

  it('should not hinder the program from exiting', function (done) {
    // Expect the instrumented app to exit after receiving an HTTP request. Will time out otherwise.
    t.proc.on('exit', (code) => {
      assert.strictEqual(code, 0)
      done()
    })
    t.axios.get(t.breakpoint.url)
  })
})
