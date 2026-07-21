'use strict'

const { defineConfig } = require('cypress')

module.exports = defineConfig({
  component: {
    devServer: {
      framework: 'react',
      bundler: 'vite',
    },
    specPattern: 'cypress/component/**/*.cy.jsx',
    supportFile: 'cypress/support/component.mjs',
  },
  video: false,
  screenshotOnRunFailure: false,
})
