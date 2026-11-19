'use strict'

const { renameSync } = require('node:fs')
const { join } = require('node:path')

const { defineConfig } = require('cypress')

module.exports = defineConfig({
  video: false,
  screenshotOnRunFailure: true,
  e2e: {
    specPattern: join(__dirname, '*.cy.js'),
    supportFile: join(__dirname, 'support.js'),
    async setupNodeEvents (on, config) {
      const plugin = require('dd-trace/ci/cypress/plugin')
      await plugin(on, config)
      // dd-trace loads too late here to wrap `on`. Before Cypress 16.3.0 this handler replaces the
      // plugin's after:screenshot handler; from 16.3.0 it runs after it. Renaming the file gives
      // after:spec a new path for a screenshot the plugin may already have uploaded.
      on('after:screenshot', (details) => {
        const path = details.path.replace(/\.png$/, '-renamed.png')
        renameSync(details.path, path)
        return { path }
      })
      return config
    },
  },
})
