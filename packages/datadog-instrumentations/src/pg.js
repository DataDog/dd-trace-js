'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const connectStartCh = channel('apm:pg:connect:start')
const connectAsyncEndCh = channel('apm:pg:connect:async-end')
const connectEndCh = channel('apm:pg:connect:end')
const connectErrorCh = channel('apm:pg:connect:error')

const queryStartCh = channel('apm:pg:query:start')
const queryAsyncEndCh = channel('apm:pg:query:async-end')
const queryEndCh = channel('apm:pg:query:end')
const queryErrorCh = channel('apm:pg:query:error')

const poolStartCh = channel('apm:pg-pool:connect:start')
const poolAsyncEndCh = channel('apm:pg-pool:connect:async-end')
const poolEndCh = channel('apm:pg-pool:connect:end')
const poolErrorCh = channel('apm:pg-pool:connect:error')

addHook({ name: 'pg', versions: ['>=4'] }, pg => {
  shimmer.wrap(pg.Client.prototype, 'connect', wrapClientConnect)
  shimmer.wrap(pg.Client.prototype, 'query', wrapQuery)
  return pg
})

addHook({ name: 'pg', file: 'lib/native/index.js', versions: ['>=4'] }, Client => {
  shimmer.wrap(Client.prototype, 'connect', wrapClientConnect)
  shimmer.wrap(Client.prototype, 'query', wrapQuery)
  return Client
})

addHook({ name: 'pg-pool', versions: ['>=2'] }, Pool => {
  shimmer.wrap(Pool.prototype, 'connect', wrapPoolConnect)
  return Pool
})

function wrapQuery (query) {
  return function () {
    if (!queryStartCh.hasSubscribers) {
      return query.apply(this, arguments)
    }

    const asyncResource = new AsyncResource('bound-anonymous-fn')

    const retval = query.apply(this, arguments)

    const queryQueue = this.queryQueue || this._queryQueue
    const activeQuery = this.activeQuery || this._activeQuery
    const pgQuery = queryQueue[queryQueue.length - 1] || activeQuery

    if (!pgQuery) {
      return retval
    }
    const statement = pgQuery.text

    queryStartCh.publish({ params: this.connectionParameters, statement })

    const finish = AsyncResource.bind(function (error) {
      if (error) {
        queryErrorCh.publish(error)
      }
      queryAsyncEndCh.publish(undefined)
    })

    if (pgQuery.callback) {
      const originalCallback = asyncResource.bind(pgQuery.callback)
      pgQuery.callback = function (err, res) {
        finish(err)
        return originalCallback.apply(this, arguments)
      }
    } else if (pgQuery.once) {
      pgQuery
        .once('error', finish)
        .once('end', () => finish())
    } else {
      pgQuery.then(() => finish(), finish)
    }

    try {
      return retval
    } catch (err) {
      queryErrorCh.publish(err)
    } finally {
      queryEndCh.publish(undefined)
    }
  }
}

function wrapClientConnect (connect) {
  return function wrappedConnect (callback) {
    if (!connectStartCh.hasSubscribers) {
      return connect.apply(this, arguments)
    }

    connectStartCh.publish({ params: this.connectionParameters })

    try {
      return wrapConnect.call(this, connect, arguments, connectAsyncEndCh, connectErrorCh)
    } finally {
      connectEndCh.publish(undefined)
    }
  }
}

function wrapPoolConnect (connect) {
  return function wrappedConnect (callback) {
    if (!poolStartCh.hasSubscribers) {
      return connect.apply(this, arguments)
    }

    poolStartCh.publish({
      max: this.options.max, // max clients/pool-size
      idleTimeoutMillis: this.options.idleTimeoutMillis, // client idle timeout
      idleCount: this.idleCount, // idle clients
      totalCount: this.totalCount, // current total clients
      waitingCount: this.waitingCount // pending queries
    })

    try {
      return wrapConnect.call(this, connect, arguments, poolAsyncEndCh, poolErrorCh)
    } finally {
      poolEndCh.publish(undefined)
    }
  }
}

function wrapConnect (connect, args, asyncEndCh, errorCh) {
  const callback = args[0]
  const asyncResource = new AsyncResource('bound-anonymous-fn')

  const finish = AsyncResource.bind(function (error) {
    if (error) {
      errorCh.publish(error)
    }
    asyncEndCh.publish(undefined)
  })

  if (callback) {
    const boundCb = asyncResource.bind(callback)

    args[0] = AsyncResource.bind(function (error) {
      finish(error)
      return boundCb.apply(this, arguments)
    })
  }

  try {
    const retval = connect.apply(this, args)

    if (retval && typeof retval.then === 'function') {
      retval.then(() => finish(), finish)
    }
    return retval
  } catch (error) {
    errorCh.publish(error)
    throw error
  }
}
