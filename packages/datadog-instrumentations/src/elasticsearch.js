'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const { storage } = require('../../datadog-core')


const startCh = channel('apm:elasticsearch:query:start')
const asyncEndCh = channel('apm:elasticsearch:query:async-end')
const endCh = channel('apm:elasticsearch:query:end')
const errorCh = channel('apm:elasticsearch:query:error')

addHook({ name: '@elastic/elasticsearch', file: 'lib/Transport.js', versions: ['>=5.6.16'] }, Transport => {
  // console.log('serrrr')
  debugger;
  shimmer.wrap(Transport.prototype, 'request', wrapRequest)
  return Transport
})

addHook({ name: 'elasticsearch', file: 'src/lib/transport.js', versions: ['>=10'] }, Transport => {
  // console.log('berrrr')
  debugger;
  shimmer.wrap(Transport.prototype, 'request', wrapRequest)
  return Transport
})

function wrapRequest(request) {
  return function (params, options, cb) {
    
    debugger;
    if (!startCh.hasSubscribers) {
      return request.apply(this, arguments)
    }

    if (!params) return request.apply(this, arguments)

    // console.log(params)
    // if (params.method === 'HEAD') {
    //   startCh.publish([params])
    // }
    // console.log(arguments)
    startCh.publish([params])
    
    const asyncResource = new AsyncResource('bound-anonymous-fn')

    const lastIndex = arguments.length - 1
    cb = arguments[lastIndex]
    


    debugger;
    if (typeof cb === 'function') {
      // cb = AsyncResource.bind(cb)
      try {
        arguments[lastIndex] = asyncResource.bind(function (error) {
          debugger;
          finish(params, error)
          // console.log(storage.getStore())
          return cb.apply(null, arguments)
        })
  
        return asyncResource.runInAsyncScope(() => {
          debugger;
          return request.apply(this, arguments)
        })
      } catch (err) {
        err.stack // trigger getting the stack at the original throwing point
        errorCh.publish(err)

        throw err
      } finally {
        endCh.publish(undefined)
      } 
      
    } else {
      debugger;
      try {
        const promise = request.apply(this, arguments)

        if (promise && typeof promise.then === 'function') {
          debugger;
          
          promise.then(() => finish(params), e => finish(params, e))
        } else {
          debugger;
          finish(params)

        }
        // console.log(33, storage.getStore())
        return promise
      } catch (err) {
        err.stack // trigger getting the stack at the original throwing point
        errorCh.publish(err)

        throw err
      } finally {
        endCh.publish(undefined)
      } 
    }
  }
}

function finish(params, error) {
  debugger;
  // console.log(37, storage.getStore())
  if (error) {
    errorCh.publish(error)
  }
  asyncEndCh.publish([params])
}