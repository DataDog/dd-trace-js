'use strict'

const BaseAwsSdkPlugin = require('../base')
const { calculatePutItemHash, calculateHashWithKnownKeys } = require('../util/dynamodb')
const log = require('../../../dd-trace/src/log')
const { DYNAMODB_PTR_KIND, SPAN_POINTER_DIRECTION } = require('../../../dd-trace/src/constants')

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

    const hashes = []
    switch (operationName) {
      case 'putItem': {
        const hash = calculatePutItemHash(
          request?.params?.TableName,
          request?.params?.Item,
          DynamoDb.getPrimaryKeyConfig()
        )
        if (hash) hashes.push(hash)
        break
      }
      case 'updateItem':
      case 'deleteItem': {
        const hash = calculateHashWithKnownKeys(request?.params?.TableName, request?.params?.Key)
        if (hash) hashes.push(hash)
        break
      }
      case 'transactWriteItems': {
        const transactItems = request?.params?.TransactItems || []
        for (const item of transactItems) {
          if (item.Put) {
            const hash = calculatePutItemHash(item.Put.TableName, item.Put.Item, DynamoDb.getPrimaryKeyConfig())
            if (hash) hashes.push(hash)
          } else if (item.Update || item.Delete) {
            const operation = item.Update ? item.Update : item.Delete
            const hash = calculateHashWithKnownKeys(operation.TableName, operation.Key)
            if (hash) hashes.push(hash)
          }
        }
        break
      }
      case 'batchWriteItem': {
        const requestItems = request?.params.RequestItems || {}
        for (const [tableName, operations] of Object.entries(requestItems)) {
          if (!Array.isArray(operations)) continue
          for (const operation of operations) {
            if (operation?.PutRequest) {
              const hash = calculatePutItemHash(tableName, operation.PutRequest.Item, DynamoDb.getPrimaryKeyConfig())
              if (hash) hashes.push(hash)
            } else if (operation?.DeleteRequest) {
              const hash = calculateHashWithKnownKeys(tableName, operation.DeleteRequest.Key)
              if (hash) hashes.push(hash)
            }
          }
        }
        break
      }
    }

    for (const hash of hashes) {
      span.addSpanPointer(DYNAMODB_PTR_KIND, SPAN_POINTER_DIRECTION.DOWNSTREAM, hash)
    }
  }

  /**
   * Loads primary key config from the `DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS` env var.
   * Only runs when needed, and warns when missing or invalid config.
   * @returns {Object|null} Parsed config from env var or null if empty/missing/invalid config.
   */
  static getPrimaryKeyConfig () {
    const config = DynamoDb.dynamoPrimaryKeyConfig || {}

    // Return cached config if valid
    if (Object.keys(config).length > 0) {
      return config
    }

    const primaryKeysEnvVar = process.env.DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS
    if (!primaryKeysEnvVar) {
      log.warn('Missing DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS env variable')
      return null
    }

    try {
      const parsedConfig = JSON.parse(primaryKeysEnvVar)

      for (const [tableName, primaryKeys] of Object.entries(parsedConfig)) {
        if (Array.isArray(primaryKeys) && primaryKeys.length > 0) {
          config[tableName] = new Set(primaryKeys)
        } else {
          log.warn(`Invalid primary key configuration for table: ${tableName}`)
        }
      }

      DynamoDb.dynamoPrimaryKeyConfig = config
      return config
    } catch (err) {
      log.warn('Failed to parse DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS:', err)
      return null
    }
  }
}

module.exports = DynamoDb
