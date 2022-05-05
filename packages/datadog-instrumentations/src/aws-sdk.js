'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

function wrapRequest (send) {
  return function wrappedRequest (cb) {
    if (!this.service) return send.apply(this, arguments)

    const serviceIdentifier = this.service.serviceIdentifier
    const channelSuffix = getChannelSuffix(serviceIdentifier)
    const startCh = channel(`apm:aws:request:start:${channelSuffix}`)
    if (!startCh.hasSubscribers) return send.apply(this, arguments)
    const outerAr = new AsyncResource('apm:aws:request:outer')

    this.on('complete', response => {
      channel(`apm:aws:request:complete:${channelSuffix}`).publish({ response })
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
        arguments[0] = wrapCb(cb, channelSuffix, this, outerAr)
      }
      return send.apply(this, arguments)
    })
  }
}

function wrapCb (cb, serviceName, request, ar) {
  return function wrappedCb (err, response) {
    const obj = { request, response }
    return ar.runInAsyncScope(() => {
      channel(`apm:aws:response:start:${serviceName}`).publish(obj)
      if (!obj.needsFinish) {
        return cb.apply(this, arguments)
      }
      const finishChannel = channel(`apm:aws:response:finish:${serviceName}`)
      try {
        let result = cb.apply(this, arguments)
        if (result && result.then) {
          result = result.then(x => {
            finishChannel.publish()
            return x
          }, e => {
            finishChannel.publish(e)
            throw e
          })
        } else {
          finishChannel.publish()
        }
        return result
      } catch (e) {
        finishChannel.publish(e)
        throw e
      }
    })
  }
}

function getChannelSuffix (name) {
  return [
    'cloudwatchlogs',
    'dynamodb',
    'eventbridge',
    'kinesis',
    'lambda',
    'redshift',
    's3',
    'sns',
    'sqs'
  ].includes(name) ? name : 'default'
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
