'use strict'

module.exports = {
  ...require('./playwright.config'),
  reporter: './ci-visibility/playwright-reporter-media-config.js',
  projects: [
    { name: 'unset', use: {} },
    { name: 'off', use: { screenshot: 'off', video: 'off' } },
    {
      name: 'options',
      use: {
        screenshot: { mode: 'off', fullPage: true },
        video: { mode: 'on-first-retry', size: { width: 320, height: 240 } },
      },
    },
    { name: 'on', use: { screenshot: 'on', video: 'on' } },
    {
      name: 'enabled-options',
      use: {
        screenshot: { mode: 'on', fullPage: true },
        video: { mode: 'on', size: { width: 320, height: 240 } },
      },
    },
  ],
}
