'use strict'

const assert = require('node:assert/strict')

const { By, Builder } = require('selenium-webdriver')
const { cleanChromeOptions, createChromeOptions } = require('../selenium-options')

const RUM_COOKIE_NAME = 'datadog-ci-visibility-test-execution-id'

describe('selenium', function () {
  let driver
  let rejectedRumCookie
  let rejectedRumCookieDeletion
  let userDataDir

  beforeEach(async function () {
    const chromeOptions = createChromeOptions()
    userDataDir = chromeOptions.userDataDir
    const build = new Builder().forBrowser('chrome').setChromeOptions(chromeOptions.options)
    driver = await build.build()
    if (process.env.REJECT_RUM_COOKIE === 'true') {
      const manage = driver.manage.bind(driver)
      driver.manage = () => {
        const options = manage()
        /**
         * @param {{ name: string, value: string }} cookie
         */
        options.addCookie = (cookie) => {
          rejectedRumCookie = cookie
          return Promise.reject(new Error('RUM correlation cookie rejected'))
        }
        /**
         * @param {string} name
         */
        options.deleteCookie = (name) => {
          rejectedRumCookieDeletion = name
          return Promise.reject(new Error('RUM correlation cookie deletion rejected'))
        }
        return options
      }
    }
  })

  it('can run selenium tests', async function () {
    await driver.get(process.env.WEB_APP_URL)
    if (process.env.REJECT_RUM_COOKIE === 'true') {
      assert.strictEqual(rejectedRumCookie.name, RUM_COOKIE_NAME)
      assert.match(rejectedRumCookie.value, /^\d+$/)
    }

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
      if (process.env.REJECT_RUM_COOKIE === 'true') {
        assert.strictEqual(rejectedRumCookieDeletion, RUM_COOKIE_NAME)
      }
    } finally {
      cleanChromeOptions(userDataDir)
      driver = undefined
      userDataDir = undefined
    }
  })
})
