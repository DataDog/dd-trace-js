'use strict'

const assert = require('assert')

const { When, Then, Before, After } = require('@cucumber/cucumber')
const { By, Builder } = require('selenium-webdriver')
const { cleanChromeOptions, createChromeOptions } = require('../../selenium-options')
let driver
let userDataDir
let title
let helloWorldText

Before(async function () {
  const chromeOptions = createChromeOptions()
  userDataDir = chromeOptions.userDataDir
  const build = new Builder().forBrowser('chrome').setChromeOptions(chromeOptions.options)
  driver = await build.build()
})

After(async function () {
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

Then('I should have run selenium', async function () {
  assert.strictEqual(title, 'Hello World')
  assert.strictEqual(helloWorldText, 'Hello World')
})

When('we run selenium', async function () {
  await driver.get(process.env.WEB_APP_URL)

  title = await driver.getTitle()

  await driver.manage().setTimeouts({ implicit: 500 })

  const helloWorld = await driver.findElement(By.className('hello-world'))

  helloWorldText = await helloWorld.getText()
})
