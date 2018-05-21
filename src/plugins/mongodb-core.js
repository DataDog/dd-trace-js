'use strict'

// TODO: remove sanitization when implemented by the agent

const shimmer = require('shimmer')

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

      let result

      tracer.trace('mongodb.query', span => {
        span.addTags({
          'service.name': config.service || 'mongodb',
          'resource.name': resource,
          'span.type': 'db',
          'db.name': ns,
          'out.host': this.s.options.host,
          'out.port': this.s.options.port
        })

        if (typeof options === 'function') {
          result = operation.call(this, ns, ops, wrapCallback(tracer, span, options))
        } else {
          result = operation.call(this, ns, ops, options, wrapCallback(tracer, span, callback))
        }
      })

      return result
    }
  }
}

function createWrapNext (tracer, config) {
  return function wrapNext (next) {
    return function nextWithTrace (cb) {
      const resource = getResource(this.ns, this.cmd)

      tracer.trace('mongodb.query', span => {
        span.addTags({
          'service.name': config.service || 'mongodb',
          'resource.name': resource,
          'span.type': 'db',
          'db.name': this.ns,
          'out.host': this.topology.s.options.host,
          'out.port': this.topology.s.options.port,
          'mongodb.cursor.index': this.cursorState.cursorIndex
        })

        next.call(this, wrapCallback(tracer, span, cb))
      })
    }
  }
}

function wrapCallback (tracer, span, done) {
  return tracer.bind((err, res) => {
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
  })
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
    if (isObject(input[key])) {
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
      shimmer.wrap(mongo.Server.prototype, 'command', createWrapOperation(tracer, config))
      shimmer.wrap(mongo.Server.prototype, 'insert', createWrapOperation(tracer, config, 'insert'))
      shimmer.wrap(mongo.Server.prototype, 'update', createWrapOperation(tracer, config, 'update'))
      shimmer.wrap(mongo.Server.prototype, 'remove', createWrapOperation(tracer, config, 'remove'))
      shimmer.wrap(mongo.Cursor.prototype, 'next', createWrapNext(tracer, config))
    },
    unpatch (mongo) {
      shimmer.unwrap(mongo.Server.prototype, 'command')
      shimmer.unwrap(mongo.Server.prototype, 'insert')
      shimmer.unwrap(mongo.Server.prototype, 'update')
      shimmer.unwrap(mongo.Server.prototype, 'remove')
      shimmer.unwrap(mongo.Cursor.prototype, 'next')
    }
  }
]
