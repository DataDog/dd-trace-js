'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const { storage } = require('../../datadog-core')

const startCh = channel('apm:redis:command:start')
const asyncEndCh = channel('apm:redis:command:async-end')
const endCh = channel('apm:redis:command:end')
const errorCh = channel('apm:redis:command:error')

addHook({ name: '@node-redis/client', file: 'dist/lib/client/commands-queue.js', versions: ['>=1'] }, redis => {
  shimmer.wrap(redis.default.prototype, 'addCommand', addCommand => function (command) {
    debugger;
    if (!startCh.hasSubscribers) {
      return addCommand.apply(this, arguments)
    }

    const asyncResource = new AsyncResource('bound-anonymous-fn')
    
    const name = command[0]
    const args = command.slice(1)

    // if (!config.filter(name)) return addCommand.apply(this, arguments)

    

    startSpan(this, name, args)
    debugger;

    try {
      // return wrap(asyncResource, AsyncResource.bind(addCommand).apply(this, arguments))

      return asyncResource.runInAsyncScope(() => { 
        return internalSendCommand.apply(this, arguments)
      })

    } catch (err) {
      err.stack // trigger getting the stack at the original throwing point
      errorCh.publish(err)

      throw err
    } finally {
      endCh.publish(undefined)
    }
  })
  return redis
})

addHook({ name: 'redis', versions: ['>=2.6 <4'] }, redis => {
  shimmer.wrap(redis.RedisClient.prototype, 'internal_send_command', internalSendCommand => function (options) {
    debugger;
    if (!startCh.hasSubscribers) {
      return internalSendCommand.apply(this, arguments)
    }
    // console.log(33, this.config)
    debugger;
    // if (!this.config.filter(options.command)) return internalSendCommand.apply(this, arguments)
    const asyncResource = new AsyncResource('bound-anonymous-fn')
    
    const cb = asyncResource.bind(options.callback)

    startSpan(this, options.command, options.args)

    debugger;

    // options.callback = AsyncResource.bind((wrap(asyncResource, cb)))

    options.callback = AsyncResource.bind(function (error) {
      finish(error)
      
      return cb.apply(this, arguments)
      // return asyncResource.runInAsyncScope(() => {
      //   return cb.apply(this, arguments)
      // })
    })

    try {
      // return wrap(asyncResource, AsyncResource.bind(addCommand).apply(this, arguments))
      // return AsyncResource.bind(internalSendCommand).apply(this, arguments)
      // return asyncResource.bind(internalSendCommand).apply(this, arguments)
      // return asyncResource.runInAsyncScope(() => { 
      //   debugger;
      //   // console.log(3000, storage.getStore())
      //   return internalSendCommand.apply(this, arguments)
      // })
      debugger

      const res = internalSendCommand.apply(this, arguments)
      console.log(45, res)
      return res
      
      // const temp = asyncResource.bind(internalSendCommand)

      // return temp.apply(this,arguments)

    } catch (err) {
      err.stack // trigger getting the stack at the original throwing point
      errorCh.publish(err)

      throw err
    } finally {
      endCh.publish(undefined)
    }
  })
  return redis
})

addHook({ name: 'redis', versions: ['>=0.12 <2.6'] }, redis => {
  shimmer.wrap(redis.RedisClient.prototype, 'send_command', sendCommand => function (command, args, callback) {
    debugger;
    if (!startCh.hasSubscribers) {
      return sendCommand.apply(this, arguments)
    }
    
    // if (!config.filter(command)) return sendCommand.apply(this, arguments)

    const asyncResource = new AsyncResource('bound-anonymous-fn')

    startSpan(this, command, args)

    
    debugger;

    if (typeof callback === 'function') {
      arguments[2] = AsyncResource.bind(wrap(asyncResource, callback))
    } else if (Array.isArray(args) && typeof args[args.length - 1] === 'function') {
      args[args.length - 1] = AsyncResource.bind(wrap(asyncResource, args[args.length - 1]))
    } else {
      arguments[2] = wrap(asyncResource)
    }

    debugger;

    try {
      // return wrap(asyncResource, AsyncResource.bind(addCommand).apply(this, arguments))
      // return AsyncResource.bind(sendCommand).apply(this, arguments)

      return asyncResource.runInAsyncScope(() => { 
        return sendCommand.apply(this, arguments)
      })

    } catch (err) {
      err.stack // trigger getting the stack at the original throwing point
      errorCh.publish(err)

      throw err
    } finally {
      endCh.publish(undefined)
    }
  })
})

function startSpan (client, command, args) {
  debugger;
  const db = client.selected_db
  const connectionOptions = client.connection_options || client.connection_option || client.connectionOption || {}
  startCh.publish([db, command, args, connectionOptions])
}

function wrap(ar, done) {
  debugger;
  if (typeof done === 'function' || !done) {
    debugger;
    return wrapCallback(ar, done)
  } else if (isPromise(done)) {
    debugger;
    return wrapPromise(ar, done)
  } else if (done && done.length) {
    debugger;
    return wrapArguments(ar, done)
  }
}

function wrapCallback (ar, callback) {
  debugger;
  // const asyncResource = new AsyncResource('bound-anonymous-fn')
  return function (err) {
    finish(err)
    
    // if (callback) {
      
    //   return ar.runInAsyncScope(() => {
    //     // console.log(3000, storage.getStore())
          //return callback.apply(this, arguments)
    //   })
    // }
    // console.log(3000, storage.getStore())

    return callback.apply(this, arguments)
  }
}

function finish (error) {
  debugger;
  // console.log(52, storage.getStore())
  if (error) {
    errorCh.publish(error)
  }
  asyncEndCh.publish(undefined)
}

function isPromise (obj) {
  return isObject(obj) && typeof obj.then === 'function'
}

function isObject (obj) {
  return typeof obj === 'object' && obj !== null
}

function wrapPromise (ar, promise) {
  debugger;
  promise.then(
    () => finish(),
    err => finish(err)
  )

  return promise
}

function wrapArguments (ar, args) {
  debugger;
  const lastIndex = args.length - 1
  const callback = args[lastIndex]

  if (typeof callback === 'function') {
    args[lastIndex] = wrapCallback(ar, args[lastIndex])
  }

  return args
}