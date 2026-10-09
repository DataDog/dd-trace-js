'use strict'

const { Then } = require('@cucumber/cucumber')

let attempts = 0
Then('the known test fails', () => { throw new Error('known failure') })
Then('the new test fails', () => { throw new Error('new failure') })
Then('the test recovers', () => {
  if (++attempts < 2) throw new Error('intermittent failure')
})
