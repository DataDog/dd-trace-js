'use strict'

const { noAutoRetry } = require('dd-trace/test-optimization')

it('late native excluded', noAutoRetry(function () {
  expect(this.test.currentRetry()).to.equal(2)
}))
it('late native control', function () {
  expect(this.test.currentRetry()).to.equal(2)
})
it('explicit local excluded', { retries: 1 }, noAutoRetry(function () {
  expect(this.test.currentRetry()).to.equal(1)
}))
