'use strict'

const assert = require('node:assert/strict')

describe('dynamic ATR duplicates', () => {
  it('same name', () => assert.fail('first declaration'))
  // eslint-disable-next-line mocha/no-identical-title -- duplicate names must retain independent retry budgets
  it('same name', () => assert.fail('second declaration'))
  const testRows = it.each(['first row', 'second row'])
  testRows('same row name', row => assert.fail(row))
})
