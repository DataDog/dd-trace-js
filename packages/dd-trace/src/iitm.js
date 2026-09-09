'use strict'

const dc = require('dc-polyfill')
const { addHook } = require('import-in-the-middle')

const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')
addHook((name, namespace) => {
  if (moduleLoadStartChannel.hasSubscribers) {
    moduleLoadStartChannel.publish({
      filename: name,
      module: namespace,
    })
  }
})
module.exports = require('import-in-the-middle')
