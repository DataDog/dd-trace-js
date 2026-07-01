'use strict'

const { By, Builder } = require('selenium-webdriver')
const { cleanChromeOptions, createChromeOptions } = require('../selenium-options')

async function run () {
  let driver
  let userDataDir

  try {
    const chromeOptions = createChromeOptions()
    userDataDir = chromeOptions.userDataDir
    const build = new Builder().forBrowser('chrome').setChromeOptions(chromeOptions.options)
    driver = await build.build()

    await driver.get(process.env.WEB_APP_URL)

    await driver.getTitle()

    await driver.manage().setTimeouts({ implicit: 500 })

    const helloWorld = await driver.findElement(By.className('hello-world'))

    await helloWorld.getText()
  } finally {
    try {
      if (driver !== undefined) {
        await driver.quit()
      }
    } finally {
      cleanChromeOptions(userDataDir)
    }
  }
}

run()
  .then(() => {
    process.exit(0)
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err)
    process.exit(1)
  })
