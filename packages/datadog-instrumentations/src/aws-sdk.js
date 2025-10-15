'use strict'

const { channel, addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

function wrapRequest (send) {
  return function wrappedRequest (cb) {
    if (!this.service) return send.apply(this, arguments)

    const serviceIdentifier = this.service.serviceIdentifier
    const channelSuffix = getChannelSuffix(serviceIdentifier)
    const startCh = channel(`apm:aws:request:start:${channelSuffix}`)
    if (!startCh.hasSubscribers) return send.apply(this, arguments)

    const ctx = {
      serviceIdentifier,
      operation: this.operation,
      awsRegion: this.service.config && this.service.config.region,
      awsService: this.service.api && this.service.api.className,
      request: this,
      cbExists: typeof cb === 'function'
    }
    process._rawDebug(`[AWS-SDK-DEBUG] Publishing start event for ${channelSuffix}:${ctx.operation}`)
    this.on('complete', response => {
      ctx.response = response
      channel(`apm:aws:request:complete:${channelSuffix}`).publish(ctx)
    })

    if (ctx.cbExists) {
      arguments[0] = wrapCb(cb, channelSuffix, ctx)
    }
    process._rawDebug(`[AWS-SDK-DEBUG] Publishing start event for ${channelSuffix}:${ctx.operation}`)
    return startCh.runStores(ctx, send, this, ...arguments)
  }
}

function wrapDeserialize (deserialize, channelSuffix) {
  const headersCh = channel(`apm:aws:response:deserialize:${channelSuffix}`)

  return function (response) {
    if (headersCh.hasSubscribers) {
      headersCh.publish({ headers: response.headers })
    }

    return deserialize.apply(this, arguments)
  }
}

function wrapSmithySend (send) {
  return function (command, ...args) {
    const cb = args.at(-1)
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
    const responseStartChannel = channel(`apm:aws:response:start:${channelSuffix}`)
    const responseFinishChannel = channel(`apm:aws:response:finish:${channelSuffix}`)

    if (typeof command.deserialize === 'function') {
      shimmer.wrap(command, 'deserialize', deserialize => wrapDeserialize(deserialize, channelSuffix))
    }

    const ctx = {
      serviceIdentifier,
      operation,
      awsService: clientName,
      request
    }

    return startCh.runStores(ctx, () => {
      // When the region is not set this never resolves so we can't await.
      this.config.region().then(region => {
        ctx.region = region
        regionCh.publish(ctx)
      })

      if (typeof cb === 'function') {
        args[args.length - 1] = shimmer.wrapFunction(cb, cb => function (err, result) {
          addResponse(ctx, err, result)

          handleCompletion(result, ctx, channelSuffix)

          const responseCtx = { request, response: ctx.response }

          responseStartChannel.runStores(responseCtx, () => {
            cb.apply(this, arguments)

            responseFinishChannel.publish(responseCtx)
          })
        })
      } else { // always a promise
        return send.call(this, command, ...args)
          .then(
            result => {
              addResponse(ctx, null, result)
              handleCompletion(result, ctx, channelSuffix)
              return result
            },
            error => {
              addResponse(ctx, error)
              handleCompletion(null, ctx, channelSuffix)
              throw error
            }
          )
      }

      return send.call(this, command, ...args)
    })
  }
}

function handleCompletion (result, ctx, channelSuffix) {
  const completeChannel = channel(`apm:aws:request:complete:${channelSuffix}`)
  const streamedChunkChannel = channel(`apm:aws:response:streamed-chunk:${channelSuffix}`)

  const iterator = result?.body?.[Symbol.asyncIterator]
  if (!iterator) {
    completeChannel.publish(ctx)
    return
  }

  shimmer.wrap(result.body, Symbol.asyncIterator, function (asyncIterator) {
    return function () {
      const iterator = asyncIterator.apply(this, arguments)
      shimmer.wrap(iterator, 'next', function (next) {
        return function () {
          return next.apply(this, arguments)
            .then(result => {
              const { done, value: chunk } = result
              streamedChunkChannel.publish({ ctx, chunk, done })

              if (done) {
                completeChannel.publish(ctx)
              }

              return result
            })
            .catch(err => {
              addResponse(ctx, err)
              completeChannel.publish(ctx)
              throw err
            })
        }
      })

      return iterator
    }
  })
}

function wrapCb (cb, serviceName, ctx) {
  // eslint-disable-next-line n/handle-callback-err
  return shimmer.wrapFunction(cb, cb => function wrappedCb (err, response) {
    ctx = { request: ctx.request, response }
    process._rawDebug(`[AWS-SDK-DEBUG] Publishing start event for ${serviceName}:${ctx.operation}`)
    return channel(`apm:aws:response:start:${serviceName}`).runStores(ctx, () => {
      const finishChannel = channel(`apm:aws:response:finish:${serviceName}`)
      try {
        let result = cb.apply(this, arguments)
        if (result && result.then) {
          result = result.then(x => {
            finishChannel.publish(ctx)
            return x
          }, e => {
            ctx.error = e
            finishChannel.publish(ctx)
            throw e
          })
        } else {
          finishChannel.publish(ctx)
        }
        return result
      } catch (e) {
        ctx.error = e
        finishChannel.publish(ctx)
        throw e
      }
    })
  })
}

function addResponse (ctx, error, result) {
  const request = ctx.request
  const response = { request, error, ...result }

  if (result && result.$metadata) {
    response.requestId = result.$metadata.requestId
  }

  ctx.response = response
}

function getChannelSuffix (name) {
  // some resource identifiers have spaces between ex: bedrock runtime
  name = String(name).replaceAll(' ', '')
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
