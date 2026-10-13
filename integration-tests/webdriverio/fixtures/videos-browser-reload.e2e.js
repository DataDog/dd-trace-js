'use strict'

const assert = require('node:assert/strict')

const { browser } = require('@wdio/globals')

describe('WebdriverIO session reload video', () => {
  it('preserves dialogs after reloading with an explicit dismiss policy', async () => {
    const sessions = (browser.isMultiremote || browser.isMultiRemote)
      ? browser.instances.map(name => browser.getInstance(name))
      : [browser]
    // Reload the last member so multiremote validation must inspect every session.
    const session = sessions.at(-1)
    const capabilities = { ...session.requestedCapabilities, unhandledPromptBehavior: 'dismiss and notify' }
    // Keep the existing ChromeDriver process while creating a new browser session.
    delete capabilities.browserName
    await session.reloadSession(capabilities)
    assert.strictEqual(session.capabilities.unhandledPromptBehavior, 'dismiss and notify')
    await session.url('data:text/html,<button onclick="alert(\'reloaded\')">Open dialog</button>')
    await session.$('button').click()
    await session.pause(700)
    assert.strictEqual(await session.getAlertText(), 'reloaded')
    await session.dismissAlert()
    assert.fail('intentional failure after verifying the dialog is preserved')
  })
})
