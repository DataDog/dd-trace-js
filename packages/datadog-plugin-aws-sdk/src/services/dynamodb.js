'use strict'

const BaseAwsSdkPlugin = require('../base')
const { generatePointerHash } = require('../../../dd-trace/src/span_pointers')
const log = require('../../../dd-trace/src/log')

class DynamoDb extends BaseAwsSdkPlugin {
  static get id () { return 'dynamodb' }
  static get peerServicePrecursors () { return ['tablename'] }

  generateTags (params, operation, response) {
    const tags = {}

    if (params) {
      if (params.TableName) {
        Object.assign(tags, {
          'resource.name': `${operation} ${params.TableName}`,
          'aws.dynamodb.table_name': params.TableName,
          tablename: params.TableName
        })
      }

      // batch operations have different format, collect table name for batch
      // https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB.html#batchGetItem-property`
      // dynamoDB batch TableName
      if (params.RequestItems !== null) {
        if (typeof params.RequestItems === 'object') {
          if (Object.keys(params.RequestItems).length === 1) {
            const tableName = Object.keys(params.RequestItems)[0]

            // also add span type to match serverless convention
            Object.assign(tags, {
              'resource.name': `${operation} ${tableName}`,
              'aws.dynamodb.table_name': tableName,
              tablename: tableName
            })
          }
        }
      }

      // TODO: DynamoDB.DocumentClient does batches on multiple tables
      // https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB/DocumentClient.html#batchGet-property
      // it may be useful to have a different resource naming convention here to show all table names
    }

    // also add span type to match serverless convention
    Object.assign(tags, {
      'span.type': 'dynamodb'
    })

    return tags
  }

  addSpanPointers (span, response) {
    const request = response?.request
    const operationName = request?.operation

    console.log('[TRACER] operationName:', operationName)
    console.log('[TRACER] request params:', request?.params)
    console.log('[TRACER] response:', response)
    console.log('[TRACER] dynamoPrimaryKeyConfig:', DynamoDb.dynamoPrimaryKeyConfig)
    switch (operationName) {
      case 'putItem': {
        // V3
        const tableName = request?.params.TableName
        const item = request?.params.Item // Get the item being inserted
        const primaryKeySet = DynamoDb.dynamoPrimaryKeyConfig[tableName]
        if (!primaryKeySet || !(primaryKeySet instanceof Set) || primaryKeySet.size === 0 || primaryKeySet.size > 2) {
          console.log('Invalid dynamo primary key config.')
          console.log('[TRACER] set type:', typeof primaryKeySet)
        }

        let primaryKey1Name = ''
        let primaryKey1Value = ''
        let primaryKey2Name = ''
        let primaryKey2Value = ''

        if (primaryKeySet.size === 1) {
          // Single key table
          primaryKey1Name = Array.from(primaryKeySet)[0]
          primaryKey1Value = item[primaryKey1Name]?.S || ''
        } else {
          // Composite key table - sort lexicographically
          const [key1, key2] = Array.from(primaryKeySet).sort()
          primaryKey1Name = key1
          primaryKey1Value = item[key1]?.S || ''
          primaryKey2Name = key2
          primaryKey2Value = item[key2]?.S || ''
        }

        const hash = generatePointerHash([
          tableName,
          primaryKey1Name,
          primaryKey1Value,
          primaryKey2Name,
          primaryKey2Value
        ])
        console.log('[TRACER] tableName:', tableName)
        console.log('[TRACER] partitionKeyName:', primaryKey1Name)
        console.log('[TRACER] partitionKeyValue:', primaryKey1Value)
        console.log('[TRACER] primaryKey2Name:', primaryKey2Name)
        console.log('[TRACER] primaryKey2Value:', primaryKey2Value)
        console.log('[TRACER] hash:', hash)
        break
      }
      default: {
        console.log('Unsupported operation.')
      }
    }
  }

  static loadPrimaryKeyNamesForTables () {
    // TODO exit early if env var not found
    const encodedTablePrimaryKeys = process.env.DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS || '{}'
    console.log('[TRACER] env var:', encodedTablePrimaryKeys)

    const tablePrimaryKeys = {}
    try {
      const rawTablePrimaryKeys = JSON.parse(encodedTablePrimaryKeys)

      for (const [table, primaryKeys] of Object.entries(rawTablePrimaryKeys)) {
        if (typeof table === 'string' && Array.isArray(primaryKeys)) {
          tablePrimaryKeys[table] = new Set(primaryKeys)
        } else {
          log.warn(`Invalid primary key configuration for table: ${table}`)
        }
      }
    } catch (err) {
      log.warn('Failed to parse DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS:', err)
      console.log('[TRACER] Failed to parse DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS:', err)
    }

    return tablePrimaryKeys
  }
}

// Initialize once when module is loaded
DynamoDb.dynamoPrimaryKeyConfig = DynamoDb.loadPrimaryKeyNamesForTables()

module.exports = DynamoDb
