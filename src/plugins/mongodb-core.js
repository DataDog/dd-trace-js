'use strict'

const Buffer = require('safe-buffer').Buffer

// TODO: remove sanitization when implemented by the agent

// Reference https://docs.mongodb.com/v3.6/reference/command/
const DATABASE_COMMANDS = [
  // Aggregation Commands
  'aggregate',
  'count',
  'distinct',
  'group',
  'mapReduce',

  // Geospatial Commands
  'geoNear',
  'geoSearch',

  // Query and Write Operation Commands
  'delete',
  'eval',
  'find',
  'findAndModify',
  'getLastError',
  'getMore',
  'getPrevError',
  'insert',
  'parallelCollectionScan',
  'resetError',
  'update',

  // Query Plan Cache Commands
  'planCacheClear',
  'planCacheClearFilters',
  'planCacheListFilters',
  'planCacheListPlans',
  'planCacheListQueryShapes',
  'planCacheSetFilter',

  // Authentication Commands
  'authenticate',
  'authSchemaUpgrade',
  'copydbgetnonce',
  'getnonce',
  'logout',

  // User Management Commands
  'createUser',
  'dropAllUsersFromDatabase',
  'dropUser',
  'grantRolesToUser',
  'revokeRolesFromUser',
  'updateUser',
  'usersInfo',

  // Role Management Commands
  'createRole',
  'dropRole',
  'dropAllRolesFromDatabase',
  'grantPrivilegesToRole',
  'grantRolesToRole',
  'invalidateUserCache',
  'revokePrivilegesFromRole',
  'revokeRolesFromRole',
  'rolesInfo',
  'updateRole',

  // Replication Commands
  'applyOps',
  'isMaster',
  'replSetAbortPrimaryCatchUp',
  'replSetFreeze',
  'replSetGetConfig',
  'replSetGetStatus',
  'replSetInitiate',
  'replSetMaintenance',
  'replSetReconfig',
  'replSetResizeOplog',
  'replSetStepDown',
  'replSetSyncFrom',
  'resync',

  // Sharding Commands
  'addShard',
  'addShardToZone',
  'balancerStart',
  'balancerStatus',
  'balancerStop',
  'checkShardingIndex',
  'cleanupOrphaned',
  'enableSharding',
  'flushRouterConfig',
  'getShardMap',
  'getShardVersion',
  'isdbgrid',
  'listShards',
  'medianKey',
  'moveChunk',
  'movePrimary',
  'mergeChunks',
  'removeShard',
  'removeShardFromZone',
  'setShardVersion',
  'shardCollection',
  'shardingState',
  'split',
  'splitChunk',
  'splitVector',
  'unsetSharding',
  'updateZoneKeyRange',

  // Session Commands
  'endSessions',
  'killAllSessions',
  'killAllSessionsByPattern',
  'killSessions',
  'refreshSessions',
  'startSession',

  // Administration Commands
  'clean',
  'clone',
  'cloneCollection',
  'cloneCollectionAsCapped',
  'collMod',
  'compact',
  'connPoolSync',
  'convertToCapped',
  'copydb',
  'create',
  'createIndexes',
  'currentOp',
  'drop',
  'dropDatabase',
  'dropIndexes',
  'filemd5',
  'fsync',
  'fsyncUnlock',
  'getParameter',
  'killCursors',
  'killOp',
  'listCollections',
  'listDatabases',
  'listIndexes',
  'logRotate',
  'reIndex',
  'renameCollection',
  'repairCursor',
  'repairDatabase',
  'setFeatureCompatibilityVersion',
  'setParameter',
  'shutdown',
  'touch',

  // Diagnostic Commands
  'availableQueryOptions',
  'buildInfo',
  'collStats',
  'connPoolStats',
  'connectionStatus',
  'cursorInfo',
  'dataSize',
  'dbHash',
  'dbStats',
  'diagLogging',
  'driverOIDTest',
  'explain',
  'features',
  'getCmdLineOpts',
  'getLog',
  'hostInfo',
  'isSelf',
  'listCommands',
  'netstat',
  'ping',
  'profile',
  'serverStatus',
  'shardConnPoolStats',
  'top',
  'validate',
  'whatsmyuri',

  // System Events Auditing Commands
  'logApplicationMessage'
]

function createWrapOperation (tracer, config, operationName) {
  return function wrapOperation (operation) {
    return function operationWithTrace (ns, ops, options, callback) {
      const resource = getResource(ns, ops, operationName)

      const parentScope = tracer.scopeManager().active()
      const span = tracer.startSpan('mongodb.query', {
        childOf: parentScope && parentScope.span()
      })

      addTags(span, tracer, config, resource, ns, this)

      if (typeof options === 'function') {
        return operation.call(this, ns, ops, wrapCallback(tracer, span, options))
      } else {
        return operation.call(this, ns, ops, options, wrapCallback(tracer, span, callback))
      }
    }
  }
}

function createWrapNext (tracer, config) {
  return function wrapNext (next) {
    return function nextWithTrace (cb) {
      const resource = getResource(this.ns, this.cmd)

      const parentScope = tracer.scopeManager().active()
      const span = tracer.startSpan('mongodb.query', {
        childOf: parentScope && parentScope.span()
      })

      addTags(span, tracer, config, resource, this.ns, this.topology)

      if (this.cursorState) {
        span.addTags({
          'mongodb.cursor.index': this.cursorState.cursorIndex
        })
      }

      next.call(this, wrapCallback(tracer, span, cb))
    }
  }
}

function addTags (span, tracer, config, resource, ns, topology) {
  span.addTags({
    'service.name': config.service || `${tracer._service}-mongodb`,
    'resource.name': resource,
    'span.type': 'mongodb',
    'db.name': ns
  })

  if (topology.s && topology.s.options) {
    span.addTags({
      'out.host': topology.s.options.host,
      'out.port': topology.s.options.port
    })
  }
}

function wrapCallback (tracer, span, done) {
  return (err, res) => {
    if (err) {
      span.addTags({
        'error.type': err.name,
        'error.msg': err.message,
        'error.stack': err.stack
      })
    }

    span.finish()

    if (done) {
      done(err, res)
    }
  }
}

function getResource (ns, cmd, operationName) {
  if (!operationName) {
    operationName = DATABASE_COMMANDS.find(name => cmd[name] !== undefined) || 'unknownCommand'
  }

  const parts = [operationName, ns]

  if (cmd.query) {
    parts.push(JSON.stringify(sanitize(cmd.query)))
  }

  return parts.join(' ')
}

function sanitize (input) {
  const output = {}

  for (const key in input) {
    if (isObject(input[key]) && !Buffer.isBuffer(input[key])) {
      output[key] = sanitize(input[key])
    } else {
      output[key] = '?'
    }
  }

  return output
}

function isObject (val) {
  return typeof val === 'object' && val !== null && !(val instanceof Array)
}

module.exports = [
  {
    name: 'mongodb-core',
    versions: ['3.x'],
    patch (mongo, tracer, config) {
      this.wrap(mongo.Server.prototype, 'command', createWrapOperation(tracer, config))
      this.wrap(mongo.Server.prototype, 'insert', createWrapOperation(tracer, config, 'insert'))
      this.wrap(mongo.Server.prototype, 'update', createWrapOperation(tracer, config, 'update'))
      this.wrap(mongo.Server.prototype, 'remove', createWrapOperation(tracer, config, 'remove'))
      this.wrap(mongo.Cursor.prototype, 'next', createWrapNext(tracer, config))
    },
    unpatch (mongo) {
      this.unwrap(mongo.Server.prototype, 'command')
      this.unwrap(mongo.Server.prototype, 'insert')
      this.unwrap(mongo.Server.prototype, 'update')
      this.unwrap(mongo.Server.prototype, 'remove')
      this.unwrap(mongo.Cursor.prototype, 'next')
    }
  }
]
