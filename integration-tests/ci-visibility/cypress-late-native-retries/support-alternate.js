'use strict'

/* global cy */
require('./support')
let executions = 0
before(() => cy.writeFile('late-support-alternate-executions.json', { executed: ++executions }))
