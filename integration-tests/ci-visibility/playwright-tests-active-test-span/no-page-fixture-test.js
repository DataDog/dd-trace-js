'use strict'

const { test: baseTest } = require('@playwright/test')

const test = baseTest.extend({
  page: async () => {
    throw new Error('The page fixture must not be initialized')
  },
})

test('does not initialize the page fixture', () => {})
