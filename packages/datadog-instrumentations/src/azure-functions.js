'use strict'

const {
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const dc = require('dc-polyfill')

const azureFunctionsChannel = dc.tracingChannel('datadog:azure-functions:http')

addHook({ name: '@azure/functions', versions: ['>=4'] }, AzureFunctions => {
  console.log(" ==== adding hook to package ==== ");
  const { app } = AzureFunctions

  shimmer.wrap(app, 'http', function (name, options) {
    console.log(" ==== wrapping azure sync func==== ");
    options.handler = function (...args) {
      return azureFunctionsChannel.traceSync(options.handler, { name, options }, this, ...args)
    }
  });

  shimmer.wrap(app, 'http', function (name, options) {
    console.log(" ==== wrapping azure async func ==== ");
    options.handler = function (...args) {
      return azureFunctionsChannel.tracePromise(options.handler, { name, options }, this, ...args)
    }
  });
})