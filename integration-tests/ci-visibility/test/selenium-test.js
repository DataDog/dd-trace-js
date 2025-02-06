'use strict'

const { By, Builder } = require('selenium-webdriver')
const chrome = require('selenium-webdriver/chrome')
const { expect } = require('chai')

const options = new chrome.Options()
options.addArguments('--headless')

describe('selenium', function () {
  let driver

  beforeEach(async function () {
    const build = new Builder().forBrowser('chrome').setChromeOptions(options)
    driver = await build.build()
  })

  it('can run selenium tests', async function () {
    await driver.get(process.env.WEB_APP_URL)

    const title = await driver.getTitle()
    expect(title).to.equal('Hello World')

    await driver.manage().setTimeouts({ implicit: 500 })

    const helloWorld = await driver.findElement(By.className('hello-world'))

    const value = await helloWorld.getText()

    expect(value).to.equal('Hello World')
  })

  afterEach(async () => await driver.quit())
})
