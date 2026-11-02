'use strict'

const { Given } = require('@cucumber/cucumber')

Given('a failing native retry assertion', () => {
  throw new Error('expected failure')
})
