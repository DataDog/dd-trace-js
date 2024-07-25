'use strict'

const {
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const dc = require('dc-polyfill')

const azureFunctionsChannel = dc.tracingChannel('datadog:azure-functions:http')

addHook({ name: '@azure/functions' }, AzureFunctions => {
    console.log(" ==== adding hook to package ==== ");
  const { app } = AzureFunctions

  shimmer.wrap(app, 'http', function (name, options) {
    options.handler = azureFunctionsChannel.traceSync(options.handler, options, { name, options })
  });
})