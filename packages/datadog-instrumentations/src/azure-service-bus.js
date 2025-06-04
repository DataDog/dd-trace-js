'use strict'

const {
  // channel,
  addHook
} = require('./helpers/instrument')

const shimmer = require('../../datadog-shimmer')

// const producerStartCh = channel('apm:azure:service-bus:produce:start')
// const producerFinishCh = channel('apm:azure:service-bus:produce:finish')
// const producerErrorCh = channel('apm:azure:service-bus:produce:error')

addHook({ name: '@azure/service-bus', versions: ['>=6'] }, (obj) => {
  shimmer.wrap(obj, 'ServiceBusSenderImpl', wrapMethod)
  return obj
})

function wrapMethod (method) {
  console.log(`Wrapping method: ${method}`)
  return function (request) {
    return method.apply(this, arguments)
  }
}

// function massWrap (obj, methods, wrapper) {
//   for (const method of methods) {
//     if (typeof obj[method] === 'function') {
//       shimmer.wrap(obj, method, wrapper)
//     }
//   }
// }
