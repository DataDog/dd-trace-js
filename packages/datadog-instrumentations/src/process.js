'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel } = require('dc-polyfill')

const startSetUncaughtExceptionCaptureCallback = channel('datadog:process:setUncaughtExceptionCaptureCallback:start')

if (process.setUncaughtExceptionCaptureCallback) {
  let currentCallback

  shimmer.wrap(process, 'setUncaughtExceptionCaptureCallback',
    function wrapSetUncaughtExceptionCaptureCallback (originalSetUncaughtExceptionCaptureCallback) {
      return function setUncaughtExceptionCaptureCallback (newCallback) {
        if (startSetUncaughtExceptionCaptureCallback.hasSubscribers) {
          const abortController = new AbortController()
          startSetUncaughtExceptionCaptureCallback.publish({ newCallback, currentCallback, abortController })
          if (abortController.signal.aborted) {
            return
          }
        }

        const result = originalSetUncaughtExceptionCaptureCallback.call(this, newCallback)

        currentCallback = newCallback

        return result
      }
    })
}
