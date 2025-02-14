'use strict'

const { expect } = require('chai')
const { By, Builder } = require('selenium-webdriver')
const chrome = require('selenium-webdriver/chrome')
const { When, Then, Before, After } = require('@cucumber/cucumber')

let driver
let title
let helloWorldText

const options = new chrome.Options()
options.addArguments('--headless')

Before(async function () {
  const build = new Builder().forBrowser('chrome').setChromeOptions(options)
  driver = await build.build()
})

After(async function () {
  await driver.quit()
})

Then('I should have run selenium', async function () {
  expect(title).to.equal('Hello World')
  expect(helloWorldText).to.equal('Hello World')
})

When('we run selenium', async function () {
  await driver.get(process.env.WEB_APP_URL)

  title = await driver.getTitle()

  await driver.manage().setTimeouts({ implicit: 500 })

  const helloWorld = await driver.findElement(By.className('hello-world'))

  helloWorldText = await helloWorld.getText()
})
