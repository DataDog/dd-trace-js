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
    const innerAr = new AsyncResource('apm:aws:request:inner')
    const outerAr = new AsyncResource('apm:aws:request:outer')

    return innerAr.runInAsyncScope(() => {
      this.on('complete', innerAr.bind(response => {
        channel(`apm:aws:request:complete:${channelSuffix}`).publish({ response })
      }))

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

function wrapSmithyClient (SmithyClient) {
  return class Client extends SmithyClient {
    constructor (...args) {
      super(...args)

      const serviceIdentifier = this.config.serviceId.toLowerCase()
      const channelSuffix = getChannelSuffix(serviceIdentifier)
      const startCh = channel(`apm:aws:request:start:${channelSuffix}`)
      const regionCh = channel(`apm:aws:request:region:${channelSuffix}`)
      const completeChannel = channel(`apm:aws:request:complete:${channelSuffix}`)
      const responseStartChannel = channel(`apm:aws:response:start:${channelSuffix}`)
      const responseFinishChannel = channel(`apm:aws:resonse:finish:${channelSuffix}`)

      this.middlewareStack.add((next, context) => async (command) => {
        if (!context.clientName) return next(command)

        const innerAr = new AsyncResource('apm:aws:request:inner')

        return innerAr.runInAsyncScope(async () => {
          const { commandName, clientName } = context
          const operation = `${commandName[0].toLowerCase()}${commandName.slice(1).replace(/Command$/, '')}`
          const request = {
            operation,
            params: command.input
          }
          const response = { request }

          startCh.publish({
            serviceIdentifier,
            operation,
            awsService: clientName.replace(/Client$/, ''),
            request
          })

          // When the region is not set this never resolves so we can't await.
          this.config.region().then(region => {
            regionCh.publish(region)
          })

          try {
            const result = await next(command) // TODO: no await

            Object.assign(response, result.output)

            response.data = response.output
            response.requestId = result.output.$metadata.requestId

            return result
          } catch (error) {
            throw response.error = error
          } finally {
            // TODO: clean up this event mess
            completeChannel.publish({ response })
            responseStartChannel.publish({ request, response })
            responseFinishChannel.publish({ request, response })
          }
        })
      }, { priority: 'high' })
    }
  }
}

function wrapCb (cb, serviceName, request, ar) {
  return function wrappedCb (err, response) {
    const obj = { request, response }
    return ar.runInAsyncScope(() => {
      channel(`apm:aws:response:start:${serviceName}`).publish(obj)
      // TODO(bengl) make this work without needing a needsFinish property added to the object
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

addHook({ name: '@aws-sdk/smithy-client', versions: ['>=3'] }, smithy => {
  return shimmer.wrap(smithy, 'Client', wrapSmithyClient)
})

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
