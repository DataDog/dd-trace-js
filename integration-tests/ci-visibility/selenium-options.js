'use strict'

const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

const chrome = require('selenium-webdriver/chrome')

/**
 * Creates Chrome options with a dedicated profile directory for one browser session.
 *
 * @returns {{ options: import('selenium-webdriver/chrome').Options, userDataDir: string }}
 */
function createChromeOptions () {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'dd-trace-selenium-'))
  const options = new chrome.Options()

  options.addArguments(
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    `--user-data-dir=${userDataDir}`
  )

  return { options, userDataDir }
}

/**
 * Removes a Chrome profile directory created for a browser session.
 *
 * @param {string|undefined} userDataDir
 * @returns {void}
 */
function cleanChromeOptions (userDataDir) {
  if (userDataDir !== undefined) {
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

module.exports = {
  cleanChromeOptions,
  createChromeOptions,
}
