'use strict'

const BaseAwsSdkPlugin = require('../base')
const log = require('../../../dd-trace/src/log')
const { DYNAMODB_PTR_KIND, SPAN_POINTER_DIRECTION } = require('../../../dd-trace/src/constants')
const { extractPrimaryKeys, generatePointerHash } = require('../../../dd-trace/src/util')

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
      case 'updateItem':
      case 'deleteItem': {
        const hash = DynamoDb.calculateHashWithKnownKeys(request?.params?.TableName, request?.params?.Key)
        if (hash) hashes.push(hash)
        break
      }
    }

    for (const hash of hashes) {
      span.addSpanPointer(DYNAMODB_PTR_KIND, SPAN_POINTER_DIRECTION.DOWNSTREAM, hash)
    }
  }

  /**
   * Calculates a hash for DynamoDB operations that have keys provided (UpdateItem, DeleteItem).
   *
   * @param {string} tableName - Name of the DynamoDB table.
   * @param {Object} keys - Object containing primary key/value attributes in DynamoDB format.
   *                       (e.g., { userId: { S: "123" }, sortKey: { N: "456" } })
   * @returns {string|undefined} Hash value combining table name and primary key/value pairs, or undefined if unable.
   *
   * @example
   * calculateKeyBasedOperationsHash('UserTable', { userId: { S: "user123" }, timestamp: { N: "1234567" } })
   */
  static calculateHashWithKnownKeys (tableName, keys) {
    if (!tableName || !keys) {
      log.debug('Unable to calculate hash because missing parameters')
      return
    }
    const keyValues = extractPrimaryKeys(keys, keys)
    if (keyValues) {
      return generatePointerHash([tableName, ...keyValues])
    }
  }
}

module.exports = DynamoDb
