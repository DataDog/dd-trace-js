'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const sinon = require('sinon')

const admissionModuleUrl = pathToFileURL(path.join(
  __dirname,
  '..',
  '..',
  '..',
  'ci',
  'vitest-efd-suite-admission.mjs'
)).href

describe('Vitest EFD suite admission', () => {
  it('disables EFD retries when the Browser Mode command rejects', async () => {
    const error = new Error('command failed')
    const originalBrowserRunner = globalThis.__vitest_browser_runner__
    const triggerCommand = sinon.stub().rejects(error)
    const consoleError = sinon.stub(globalThis.console, 'error')
    globalThis.__vitest_browser_runner__ = {
      commands: { triggerCommand },
    }

    try {
      const { requestEfdSuiteAdmission } = await import(admissionModuleUrl)
      const isAllowed = await requestEfdSuiteAdmission({
        browserCommand: 'admit',
        hasNewTest: true,
        requestCode: 104,
        responseCode: 105,
        testSuite: 'test.mjs',
      })

      assert.strictEqual(isAllowed, false)
      assert.strictEqual(triggerCommand.callCount, 1)
      assert.strictEqual(consoleError.callCount, 1)
      assert.strictEqual(consoleError.firstCall.args[1], error)
    } finally {
      consoleError.restore()
      if (originalBrowserRunner === undefined) {
        delete globalThis.__vitest_browser_runner__
      } else {
        globalThis.__vitest_browser_runner__ = originalBrowserRunner
      }
    }
  })
})
