'use strict'

module.exports = { testDir: '.', testMatch: 'playwright.js', retries: Number(process.env.NATIVE_RETRIES) || 0 }
