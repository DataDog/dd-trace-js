'use strict'

/* global cy */

const { noAutoRetry, preventFailureSuppression } = require('dd-trace/test-optimization')
const { getTestEnvironment } = require('../support/test-environment')

const mode = getTestEnvironment('EXCLUSIONS_MODE')
let executions = 0
const callback = () => {
  return cy.writeFile('independent-exclusion-executions.json', { executions: ++executions }, { log: false })
    .then(() => {
      if (mode !== 'protection-pass') throw new Error('independent exclusion failure')
    })
}
const annotated = mode.startsWith('protection')
  ? preventFailureSuppression(callback)
  : mode.startsWith('excluded') ? noAutoRetry(callback) : callback
it('sole', annotated)
