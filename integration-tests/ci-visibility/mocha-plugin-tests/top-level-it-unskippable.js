/* eslint-disable jsdoc/valid-types */
/**
 * @datadog {"unskippable": true}
 */
'use strict'

before(() => { process.stdout.write('unskippable before hook\n') })
after(() => { process.stdout.write('unskippable after hook\n') })
beforeEach(() => { process.stdout.write('unskippable beforeEach hook\n') })
afterEach(() => { process.stdout.write('unskippable afterEach hook\n') })

it('unskippable root-level test', () => {})
