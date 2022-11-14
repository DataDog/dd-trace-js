'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const fsCahnnel = channel('datadog:fs:access')
const fsMethods = ['openSync']

addHook({ name: 'fs' }, fs => {
  shimmer.massWrap(fs, fsMethods, wrapFsMethod(fsCahnnel))
  return fs
})

function wrapFsMethod (channel) {
  function wrapMethod (fsMethod) {
    return function () {
      if (channel.hasSubscribers && arguments.length) {
        // TODO(julio): check if arg 0 is String
        channel.publish(arguments[0])
      }
      return fsMethod.apply(this, arguments)
    }
  }
  return wrapMethod
}
