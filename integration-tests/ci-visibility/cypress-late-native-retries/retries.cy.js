'use strict'

/* global cy */

const { noAutoRetry } = require('dd-trace/test-optimization')
const executions = {}
const record = name => {
  executions[name] = (executions[name] || 0) + 1
  return cy.writeFile('late-native-retry-executions.json', executions, { log: false })
}

it('late native excluded', noAutoRetry(function () {
  return record(this.test.title).then(() => expect(this.test.currentRetry()).to.equal(2))
}))
it('late native control', function () {
  return record(this.test.title).then(() => expect(this.test.currentRetry()).to.equal(2))
})
it('explicit local excluded', { retries: 1 }, noAutoRetry(function () {
  return record(this.test.title).then(() => expect(this.test.currentRetry()).to.equal(1))
}))
