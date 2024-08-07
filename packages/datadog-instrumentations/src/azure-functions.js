'use strict'

const {
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const dc = require('dc-polyfill')

const azureFunctionsChannel = dc.tracingChannel('datadog:azure-functions:http')

addHook({ name: '@azure/functions', versions: ['>=4'] }, AzureFunctions => {
  console.log(' ==== adding hook to package ==== ')
  const { app } = AzureFunctions

  try {
    shimmer.wrap(app, 'http', wrapFetch)
  } catch (error) {
    console.error('error: ', error)
  }
  return AzureFunctions
})

function wrapFetch (http) {
  return function (name, options) {
    console.log(' ==== wrapping azure async func ==== ')
    shimmer.wrap(options, 'handler', (handler) =>
      function (...args) {
        console.log(' ==== inside of handler ==== ')
        return azureFunctionsChannel.tracePromise(handler, { name, options }, this, ...args)
      })
    return http.apply(this, arguments)
  }
}
