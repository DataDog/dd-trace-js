'use strict'

const assert = require('node:assert/strict')

require('./shared-root-hooks')

before(() => { assert.fail('The skipped file before hook must not run') })
after(() => { assert.fail('The skipped file after hook must not run') })
beforeEach(() => { assert.fail('The skipped file beforeEach hook must not run') })
afterEach(() => { assert.fail('The skipped file afterEach hook must not run') })

it('test in the first shared-helper importer', () => {})
