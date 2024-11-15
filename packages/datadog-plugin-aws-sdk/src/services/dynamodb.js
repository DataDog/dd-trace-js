'use strict'

const BaseAwsSdkPlugin = require('../base')
const { calculatePutItemHash, calculateKeyBasedOperationsHash } = require('../util/dynamodb')
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

    // Temporary logs
    console.log('[TRACER] operationName:', operationName)
    // console.log('[TRACER] request params:', request?.params)
    // console.log('[TRACER] response:', response)
    // console.log('[TRACER] dynamoPrimaryKeyConfig:', DynamoDb.dynamoPrimaryKeyConfig)

    const tableName = request?.params.TableName
    console.log('[TRACER] tableName:', tableName)
    const hashes = []
    switch (operationName) {
      case 'putItem': {
        const hash = calculatePutItemHash(tableName, request?.params.Item, DynamoDb.dynamoPrimaryKeyConfig)
        hashes.push(hash)
        break
      }
      case 'updateItem':
      case 'deleteItem': {
        const hash = calculateKeyBasedOperationsHash(tableName, request?.params.Key)
        hashes.push(hash)
        break
      }
      default: {
        console.log('Unsupported operation.')
      }
    }

    console.log('[TRACER] hashes:', hashes)
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
