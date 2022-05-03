'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('apm:aws:request:start')
const responseCh = channel('apm:aws:response')
const completeCh = channel('apm:aws:request:complete')

function wrapRequest (send) {
  return function wrappedRequest (cb) {
    if (!this.service) return send.apply(this, arguments)
    const outerAr = new AsyncResource('apm:aws:request:outer')

    const serviceIdentifier = this.service.serviceIdentifier

    this.on('complete', response => {
      completeCh.publish({ response, serviceIdentifier })
    })

    return new AsyncResource('apm:aws:request:inner').runInAsyncScope(() => {
      startCh.publish({
        serviceIdentifier,
        operation: this.operation,
        awsRegion: this.service.config && this.service.config.region,
        awsService: this.service.api && this.service.api.className,
        request: this
      })

      if (typeof cb === 'function') {
        arguments[0] = wrapCb(cb, serviceIdentifier, this, outerAr)
      }
      return send.apply(this, arguments)
    })
  }
}

function wrapCb (cb, serviceName, request, ar) {
  return function wrappedCb (err, response) {
    const obj = {
      request, response, serviceName, ar
    }
    responseCh.publish(obj)
    return obj.ar.runInAsyncScope(() => cb.apply(this, arguments))
  }
}

addHook({ name: 'aws-sdk', versions: ['>=2.3.0'] }, AWS => {
  shimmer.wrap(AWS.Request.prototype, 'promise', wrapRequest)
  shimmer.wrap(AWS.config, 'setPromisesDependency', setPromisesDependency => {
    return function wrappedSetPromisesDependency (dep) {
      const result = setPromisesDependency.apply(this, arguments)
      shimmer.wrap(AWS.Request.prototype, 'promise', wrapRequest)
      return result
    }
  })
  return AWS
})

// <2.1.35 has breaking changes for instrumentation
// https://github.com/aws/aws-sdk-js/pull/629
addHook({ name: 'aws-sdk', versions: ['>=2.1.35'] }, AWS => {
  shimmer.wrap(AWS.Request.prototype, 'send', wrapRequest)
  return AWS
})
