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

  try{
    shimmer.wrap(app, 'http', function (name, options) {
      console.log(" ==== wrapping azure async func ==== ");
      options.handler = function (...args) {
        console.log(" ==== inside of handler ==== ");
        return azureFunctionsChannel.tracePromise(options.handler, { name, options }, this, ...args)
      }
    });
  }catch(error){
    console.error("error: ", error);
  }
})