'use strict'

const tracer = require('dd-trace')
const { test } = require('@playwright/test')

for (const name of ['listed', 'unlisted']) {
  // Playwright requires fixture destructuring even when no fixtures are used.
  // eslint-disable-next-line no-empty-pattern
  test(name, ({}, testInfo) => {
    tracer.scope().active().setTag('test.retry_source', testInfo.project.metadata.retrySource)
    throw new Error('failure')
  })
}
