'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { channel } = require('dc-polyfill')

require('dd-trace/init')
require('@playwright/test')

channel('dd-trace:instrumentation:load').publish({ name: 'playwright' })

const suitePath = path.join(process.cwd(), 'pending-upload-test.js')
const screenshotPath = path.join(process.cwd(), 'test-failed-1.png')
fs.copyFileSync(
  path.join(process.cwd(), 'ci-visibility/test-early-flake-detection/__image_snapshots__',
    'jest-image-snapshot-js-snapshot-can-match-1-snap.png'),
  screenshotPath
)

channel('ci:playwright:session:start').publish({
  command: 'playwright test',
  frameworkVersion: require('@playwright/test/package.json').version,
  rootDir: process.cwd(),
  isFailureScreenshotEnabled: true,
})

const suiteContext = { testSuiteAbsolutePath: suitePath }
channel('ci:playwright:test-suite:start').runStores(suiteContext, () => {})
channel('ci:playwright:test-suite:finish').publish({
  ...suiteContext.currentStore,
  status: 'fail',
})

channel('ci:playwright:worker:report').publish({
  serializedTraces: JSON.stringify([[
    {
      trace_id: '0000000000000001',
      span_id: '0000000000000002',
      parent_id: '0000000000000000',
      name: 'playwright.test',
      resource: 'pending-upload-test.js.pending upload',
      service: 'node',
      type: 'test',
      error: 1,
      meta: {
        'test.name': 'pending upload',
        'test.status': 'fail',
        test_suite_absolute_path: suitePath,
        test_source_absolute_path: suitePath,
      },
      metrics: {},
      start: Date.now() * 1e6,
      duration: 1e6,
    },
  ]]),
  screenshots: [{
    name: 'screenshot',
    contentType: 'image/png',
    path: screenshotPath,
  }],
})

setImmediate(() => {
  const error = new Error('custom Playwright reporter failed')
  channel('ci:playwright:session:finish').publish({
    status: 'fail',
    error,
    onDone () {
      process.exitCode = 1
      // Mirrors Playwright reporting the original reporter error before exiting.
      // eslint-disable-next-line no-console
      console.error(error)
      throw error
    },
  })
})
