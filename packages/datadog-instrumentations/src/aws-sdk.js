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
        const cbExists = typeof cb === 'function'
        channel(`apm:aws:request:complete:${channelSuffix}`).publish({ response, cbExists })
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
        args[args.length - 1] = shimmer.wrapFunction(cb, cb => function (err, result) {
          const message = getMessage(request, err, result)

          completeChannel.publish(message)

          outerAr.runInAsyncScope(() => {
            responseStartChannel.publish(message)

            cb.apply(this, arguments)

            if (message.needsFinish) {
              responseFinishChannel.publish(message.response.error)
            }
          })
        })
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
  return shimmer.wrapFunction(cb, cb => function wrappedCb (err, response) {
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
  })
}

function getMessage (request, error, result) {
  const response = { request, error, ...result }

  if (result && result.$metadata) {
    response.requestId = result.$metadata.requestId
  }

  return { request, response }
}

function getChannelSuffix (name) {
  // some resource identifiers have spaces between ex: bedrock runtime
  name = name.replaceAll(' ', '')
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
    'stepfunctions',
    'bedrockruntime'
  ].includes(name)
    ? name
    : 'default'
}

addHook({ name: '@smithy/smithy-client', versions: ['>=1.0.3'] }, smithy => {
  shimmer.wrap(smithy.Client.prototype, 'send', wrapSmithySend)

  // wrapped for Bedrock model commands
  shimmer.wrap(smithy.Command, 'classBuilder', wrapClassBuilder) // static function
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

// Hooks into the deserialization of BedrockRuntime commands
// This is so we can extract the token usages before they are dropped from the response metadata

const commands = new Set(['InvokeModelCommand'])

/**
 * Wraps the static classBuilder function of the Command class.
 * The Bedrock Runtime client uses this class builder to set its deserializers, which are
 * not available on the model command instances at the time of patching.
 *
 * We attempt to extract the deserializer here and wrap it to extract the necessary headers.
 */
function wrapClassBuilder (classBuilder) {
  return function () {
    const builder = classBuilder.apply(this, arguments)
    shimmer.wrap(builder, 'de', deserialize => {
      return function () {
        const deserializerName = arguments[0]?.name?.split('de_')[1]
        if (commands.has(deserializerName)) {
          const originalDeserializer = arguments[0]
          arguments[0] = shimmer.wrapFunction(originalDeserializer, wrapBedrockCommandDeserialize)
        }

        return deserialize.apply(this, arguments)
      }
    })
    return builder
  }
}

/**
 * Wraps the deserializer function of BedrockRuntime commands.
 * This is to extract the token headers from the response metadata before they are dropped.
 *
 * Request ID is extracted and can be used by subscribers to match the request ID in the response
 * to the token counts.
 */
function wrapBedrockCommandDeserialize (deserialize) {
  return function (response) {
    const tokenCh = channel('apm:aws:token:bedrockruntime')

    const requestId = response.headers['x-amzn-requestid']
    const inputTokenCount = response.headers['x-amzn-bedrock-input-token-count']
    const outputTokenCount = response.headers['x-amzn-bedrock-output-token-count']

    tokenCh.publish({ requestId, inputTokenCount, outputTokenCount })

    return deserialize.apply(this, arguments)
  }
}

addHook({
  name: '@aws-sdk/client-bedrock-runtime',
  versions: ['>=3.422.0 <3.451.0']
}, BedrockRuntime => {
  for (const command of commands) {
    const Command = BedrockRuntime[command]
    shimmer.wrap(Command.prototype, 'deserialize', wrapBedrockCommandDeserialize)
  }
  return BedrockRuntime
})
