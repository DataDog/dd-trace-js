'use strict'

const assert = require('node:assert/strict')

const { browser } = require('@wdio/globals')

describe('WebdriverIO browser videos', () => {
  beforeEach(() => {
    const sessions = (browser.isMultiremote || browser.isMultiRemote)
      ? browser.instances.map(name => browser.getInstance(name))
      : [browser]
    for (const session of sessions) {
      assert.strictEqual(session.isBidi, process.env.WEBDRIVERIO_CLASSIC !== 'true')
      assert.strictEqual(session.capabilities.unhandledPromptBehavior, 'ignore')
    }
  })

  it('discards a passing recording', async () => {
    await browser.url('data:text/html,<body style="background:white">Passing attempt</body>')
  })

  it('preserves dialogs during command-triggered and periodic captures', async () => {
    const sessions = (browser.isMultiremote || browser.isMultiRemote)
      ? browser.instances.map(name => browser.getInstance(name))
      : [browser]
    for (const session of sessions) {
      // WDIO's BiDi dialog manager otherwise dismisses dialogs itself when no listener is registered.
      const onDialog = () => {}
      session.on('dialog', onDialog)
      try {
        for (const type of ['alert', 'confirm', 'prompt']) {
          const html = `<button onclick="window.dialogResult=${type}('${type}')">Open dialog</button>`
          await session.url(`data:text/html,${encodeURIComponent(html)}`)
          await session.$('button').click()
          await session.pause(700)
          assert.strictEqual(await session.getAlertText(), type)
          if (type === 'prompt') await session.sendAlertText('answer')
          await session.acceptAlert()
          if (type !== 'alert') {
            const result = await session.execute(() => globalThis.dialogResult)
            assert.strictEqual(result, type === 'confirm' ? true : 'answer')
          }
        }
        // The dialog opens after the command completes, while background captures remain active.
        await session.execute(() => { setTimeout(() => globalThis.alert('delayed'), 100) })
        await session.pause(700)
        assert.strictEqual(await session.getAlertText(), 'delayed')
        await session.dismissAlert()
      } finally {
        session.off('dialog', onDialog)
      }
    }
  })

  it('records navigation, commands, idle periods and the failed page', async () => {
    for (const [color, text, width, height] of /** @type {const} */ ([
      ['red', 'START', 1001, 801], ['lime', 'NAVIGATED', 1203, 903], ['blue', 'FAILURE', 801, 701],
    ])) {
      await browser.setWindowSize(width, height)
      const html = `<body style="background:${color};color:white;font:48px sans-serif">
        <h1>${text}</h1><button onclick="this.textContent='Clicked'">Click me</button></body>`
      // Each navigation replaces the document, as in a real browser test.
      await browser.url(`data:text/html,${encodeURIComponent(html)}`)
      await browser.$('button').click()
      await browser.pause(800)
    }
    assert.fail('intentional failure for video inspection')
  })

  // A skipped attempt must not produce a video.
  xit('does not record a skipped attempt', () => {})
})
