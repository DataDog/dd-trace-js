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

function wrapSmithySend (send) {
  return function (command, ...args) {
    const cb = args[args.length - 1]
    const innerAr = new AsyncResource('apm:aws:request:inner')
    const outerAr = new AsyncResource('apm:aws:request:outer')
    const serviceIdentifier = this.config.serviceId.toLowerCase()
    const channelSuffix = getChannelSuffix(serviceIdentifier)
    const commandName = command.constructor.name
    const clientName = this.constructor.name.replace(/Client$/, '')
    const operation = `${commandName[0].toLowerCase()}${commandName.slice(1).replace(/Command$/, '')}`
    const request = {
      operation,
      params: command.input
    }

    const startCh = channel(`apm:aws:request:start:${channelSuffix}`)
    const regionCh = channel(`apm:aws:request:region:${channelSuffix}`)
    const completeChannel = channel(`apm:aws:request:complete:${channelSuffix}`)
    const responseStartChannel = channel(`apm:aws:response:start:${channelSuffix}`)
    const responseFinishChannel = channel(`apm:aws:response:finish:${channelSuffix}`)

    return innerAr.runInAsyncScope(() => {
      startCh.publish({
        serviceIdentifier,
        operation,
        awsService: clientName,
        request
      })

      // When the region is not set this never resolves so we can't await.
      this.config.region().then(region => {
        regionCh.publish(region)
      })

      if (typeof cb === 'function') {
        args[args.length - 1] = function (err, result) {
          const message = getMessage(request, err, result)

          completeChannel.publish(message)

          outerAr.runInAsyncScope(() => {
            responseStartChannel.publish(message)

            cb.apply(this, arguments)

            if (message.needsFinish) {
              responseFinishChannel.publish(message.response.error)
            }
          })
        }
      } else { // always a promise
        return send.call(this, command, ...args)
          .then(
            result => {
              const message = getMessage(request, null, result)
              completeChannel.publish(message)
              return result
            },
            error => {
              const message = getMessage(request, error)
              completeChannel.publish(message)
              throw error
            }
          )
      }

      return send.call(this, command, ...args)
    })
  }
}

function wrapCb (cb, serviceName, request, ar) {
  // eslint-disable-next-line n/handle-callback-err
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

function getMessage (request, error, result) {
  const response = { request, error, ...result }

  if (result && result.$metadata) {
    response.requestId = result.$metadata.requestId
  }

  return { request, response }
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
    'sfn',
    'sns',
    'sqs',
    'states',
    'stepfunctions'
  ].includes(name)
    ? name
    : 'default'
}

addHook({ name: '@smithy/smithy-client', versions: ['>=1.0.3'] }, smithy => {
  shimmer.wrap(smithy.Client.prototype, 'send', wrapSmithySend)
  return smithy
})

addHook({ name: '@aws-sdk/smithy-client', versions: ['>=3'] }, smithy => {
  shimmer.wrap(smithy.Client.prototype, 'send', wrapSmithySend)
  return smithy
})

addHook({ name: 'aws-sdk', versions: ['>=2.3.0'] }, AWS => {
  shimmer.wrap(AWS.config, 'setPromisesDependency', setPromisesDependency => {
    return function wrappedSetPromisesDependency (dep) {
      const result = setPromisesDependency.apply(this, arguments)
      shimmer.wrap(AWS.Request.prototype, 'promise', wrapRequest)
      return result
    }
  })
  return AWS
})

addHook({ name: 'aws-sdk', file: 'lib/core.js', versions: ['>=2.3.0'] }, AWS => {
  shimmer.wrap(AWS.Request.prototype, 'promise', wrapRequest)
  return AWS
})

// <2.1.35 has breaking changes for instrumentation
// https://github.com/aws/aws-sdk-js/pull/629
addHook({ name: 'aws-sdk', file: 'lib/core.js', versions: ['>=2.1.35'] }, AWS => {
  shimmer.wrap(AWS.Request.prototype, 'send', wrapRequest)
  return AWS
})
