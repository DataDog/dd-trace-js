'use strict'

const { Given } = require('@cucumber/cucumber')

Given('an excluded failure', function () {
  throw new Error('protected failure')
})
Given('an excluded pass', function () {})
