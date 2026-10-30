'use strict'

/* global cy */
const { noAutoRetry } = require('dd-trace/test-optimization')
it('support reuse smoke', noAutoRetry(() => {
  return cy.readFile('late-native-retry-executions.json').then(executions => {
    executions['support reuse smoke'] = (executions['support reuse smoke'] || 0) + 1
    return cy.writeFile('late-native-retry-executions.json', executions, { log: false })
  })
}))
