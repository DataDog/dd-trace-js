'use strict'

const assert = require('assert')

const { By, Builder } = require('selenium-webdriver')
const { cleanChromeOptions, createChromeOptions } = require('../selenium-options')

describe('selenium', function () {
  let driver
  let userDataDir

  beforeEach(async function () {
    const chromeOptions = createChromeOptions()
    userDataDir = chromeOptions.userDataDir
    const build = new Builder().forBrowser('chrome').setChromeOptions(chromeOptions.options)
    driver = await build.build()
  })

  it('can run selenium tests', async function () {
    await driver.get(process.env.WEB_APP_URL)

    const title = await driver.getTitle()
    assert.strictEqual(title, 'Hello World')

    await driver.manage().setTimeouts({ implicit: 500 })

    const helloWorld = await driver.findElement(By.className('hello-world'))

    const value = await helloWorld.getText()

    assert.strictEqual(value, 'Hello World')
  })

  afterEach(async () => {
    try {
      if (driver !== undefined) {
        await driver.quit()
      }
    } finally {
      cleanChromeOptions(userDataDir)
      driver = undefined
      userDataDir = undefined
    }
  })
})
