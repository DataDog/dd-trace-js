'use strict'

const BaseAwsSdkPlugin = require('../base')
const log = require('../../../dd-trace/src/log')
const { DYNAMODB_PTR_KIND, SPAN_POINTER_DIRECTION } = require('../../../dd-trace/src/constants')
const { extractPrimaryKeys, generatePointerHash } = require('../util')

class DynamoDb extends BaseAwsSdkPlugin {
  static id = 'dynamodb'
  static peerServicePrecursors = ['tablename']
  static isPayloadReporter = true

  generateTags (params, operation, response) {
    const tags = {}

    if (params) {
      let tableName = params.TableName

      // Collect table name for batch operations which have different format
      // https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB.html#batchGetItem-property`
      // dynamoDB batch TableName
      if (params.RequestItems !== null && typeof params.RequestItems === 'object') {
        const requestItemsKeys = Object.keys(params.RequestItems)
        if (requestItemsKeys.length === 1) {
          tableName = requestItemsKeys[0]
        }
      }

      if (tableName) {
        // Also add span type to match serverless convention
        tags['resource.name'] = `${operation} ${tableName}`
        tags['aws.dynamodb.table_name'] = tableName
        tags.tablename = tableName
      }

      // TODO: DynamoDB.DocumentClient does batches on multiple tables
      // https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB/DocumentClient.html#batchGet-property
      // it may be useful to have a different resource naming convention here to show all table names
    }

    // Also add span type to match serverless convention
    tags['span.type'] = 'dynamodb'

    return tags
  }

  addSpanPointers (span, response) {
    const request = response?.request
    const operationName = request?.operation

    const hashes = []
    switch (operationName) {
      case 'putItem': {
        const hash = DynamoDb.calculatePutItemHash(
          request?.params?.TableName,
          request?.params?.Item,
          this.getPrimaryKeyConfig()
        )
        if (hash) hashes.push(hash)
        break
      }
      case 'updateItem':
      case 'deleteItem': {
        const hash = DynamoDb.calculateHashWithKnownKeys(request?.params?.TableName, request?.params?.Key)
        if (hash) hashes.push(hash)
        break
      }
      case 'transactWriteItems': {
        const transactItems = request?.params?.TransactItems || []
        for (const item of transactItems) {
          if (item.Put) {
            const hash =
              DynamoDb.calculatePutItemHash(item.Put.TableName, item.Put.Item, this.getPrimaryKeyConfig())
            if (hash) hashes.push(hash)
          } else {
            const operation = item.Update || item.Delete
            if (operation) {
              const hash = DynamoDb.calculateHashWithKnownKeys(operation.TableName, operation.Key)
              if (hash) hashes.push(hash)
            }
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
              const hash =
                DynamoDb.calculatePutItemHash(tableName, operation.PutRequest.Item, this.getPrimaryKeyConfig())
              if (hash) hashes.push(hash)
            } else if (operation?.DeleteRequest) {
              const hash = DynamoDb.calculateHashWithKnownKeys(tableName, operation.DeleteRequest.Key)
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
   * Parses primary key config from the `DD_TRACE_DYNAMODB_TABLE_PRIMARY_KEYS` env var.
   * Only runs when needed, and warns when missing or invalid config.
   * @returns {Object|undefined} Parsed config from env var or undefined if empty/missing/invalid config.
   */
  getPrimaryKeyConfig () {
    if (this.dynamoPrimaryKeyConfig) {
      // Return cached config if it exists
      return this.dynamoPrimaryKeyConfig
    }

    const configStr = this._tracerConfig?.trace?.dynamoDb?.tablePrimaryKeys
    if (!configStr) {
      log.warn(
        // eslint-disable-next-line @stylistic/max-len
        'Missing DD_TRACE_DYNAMODB_TABLE_PRIMARY_KEYS env variable. Please add your table\'s primary keys under this env variable.'
      )
      return
    }

    try {
      const parsedConfig = JSON.parse(configStr)
      const config = {}
      for (const [tableName, primaryKeys] of Object.entries(parsedConfig)) {
        if (Array.isArray(primaryKeys) && primaryKeys.length > 0 && primaryKeys.length <= 2) {
          config[tableName] = primaryKeys
        } else {
          log.warn(
            // eslint-disable-next-line @stylistic/max-len
            'Invalid primary key configuration for table: %s. Please fix the DD_TRACE_DYNAMODB_TABLE_PRIMARY_KEYS env var.',
            tableName
          )
        }
      }

      this.dynamoPrimaryKeyConfig = config
      return config
    } catch (err) {
      log.warn('Failed to parse DD_TRACE_DYNAMODB_TABLE_PRIMARY_KEYS:', err.message)
    }
  }

  /**
   * Calculates a hash for DynamoDB PutItem operations using table's configured primary keys.
   * @param {string} tableName - Name of the DynamoDB table.
   * @param {Object} item - Complete PutItem item parameter to be put.
   * @param {Object.<string, Array<string>>} primaryKeyConfig - Mapping of table names to an Array of primary key names
   *                                                         loaded from DD_TRACE_DYNAMODB_TABLE_PRIMARY_KEYS.
   * @returns {string|undefined} Hash combining table name and primary key/value pairs, or undefined if unable.
   */
  static calculatePutItemHash (tableName, item, primaryKeyConfig) {
    if (!tableName || !item) {
      log.debug('Unable to calculate hash because missing required parameters')
      return
    }
    const keyNames = primaryKeyConfig?.[tableName]
    if (!keyNames) {
      return
    }
    const keyValues = extractPrimaryKeys(keyNames, item)
    if (keyValues) {
      return generatePointerHash([tableName, ...keyValues])
    }
  }

  /**
   * Calculates a hash for DynamoDB operations that have keys provided (UpdateItem, DeleteItem).
   * @param {string} tableName - Name of the DynamoDB table.
   * @param {Object} keysObject - Object containing primary key/value attributes in DynamoDB format.
   *                       (e.g., { userId: { S: "123" }, sortKey: { N: "456" } })
   * @returns {string|undefined} Hash value combining table name and primary key/value pairs, or undefined if unable.
   *
   * @example
   * calculateHashWithKnownKeys('UserTable', { userId: { S: "user123" }, timestamp: { N: "1234567" } })
   */
  static calculateHashWithKnownKeys (tableName, keysObject) {
    if (!tableName || !keysObject) {
      log.debug('Unable to calculate hash because missing parameters')
      return
    }
    const keyNames = Object.keys(keysObject)
    const keyValues = extractPrimaryKeys(keyNames, keysObject)
    if (keyValues) {
      return generatePointerHash([tableName, ...keyValues])
    }
  }
}

module.exports = DynamoDb
