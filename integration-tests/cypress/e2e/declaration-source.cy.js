'use strict'

/* global expect */

const { noAutoRetry } = require('dd-trace/test-optimization')

let ordinaryLine
it('ordinary declaration source', function () {
  ordinaryLine = this.test.invocationDetails.line
  expect(ordinaryLine).to.be.a('number')
})

specify('annotated declaration source', noAutoRetry(function () {
  const annotatedLine = this.test.invocationDetails.line
  expect(annotatedLine).to.be.a('number')
  expect(annotatedLine).not.to.equal(ordinaryLine)
}))
