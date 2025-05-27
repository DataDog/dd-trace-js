'use strict'

const { By, Builder } = require('selenium-webdriver')
const chrome = require('selenium-webdriver/chrome')

async function run () {
  const options = new chrome.Options()
  options.addArguments('--headless')
  const build = new Builder().forBrowser('chrome').setChromeOptions(options)
  const driver = await build.build()

  await driver.get(process.env.WEB_APP_URL)

  await driver.getTitle()

  await driver.manage().setTimeouts({ implicit: 500 })

  const helloWorld = await driver.findElement(By.className('hello-world'))

  await helloWorld.getText()

  return driver.quit()
}

run()
  .then(() => {
    process.exit(0)
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err)
    process.exit(1)
  })
