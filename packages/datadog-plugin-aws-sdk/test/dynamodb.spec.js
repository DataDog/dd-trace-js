'use strict'

const axios = require('axios')
const { expect } = require('chai')
const { describe, it, beforeEach, before, after } = require('mocha')

const util = require('node:util')
const { setTimeout: wait } = require('node:timers/promises')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { setup } = require('./spec-helpers')
const { DYNAMODB_PTR_KIND, SPAN_POINTER_DIRECTION } = require('../../dd-trace/src/constants')
const DynamoDb = require('../src/services/dynamodb')
const { generatePointerHash } = require('../src/util')

/* eslint-disable no-console */
async function resetLocalStackDynamo () {
  try {
    await axios.post('http://localhost:4566/reset')
    console.log('LocalStack Dynamo reset successful')
  } catch (error) {
    console.error('Error resetting LocalStack Dynamo:', error.message)
  }
}

describe('Plugin', () => {
  describe('aws-sdk (dynamodb)', function () {
    setup()

    withVersions('aws-sdk', ['aws-sdk', '@aws-sdk/smithy-client'], (version, moduleName) => {
      let tracer
      let AWS
      let dynamo

      const dynamoClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-dynamodb' : 'aws-sdk'

      // Test both cases: tables with only partition key and with partition+sort key.
      const oneKeyTableName = 'OneKeyTable'
      const twoKeyTableName = 'TwoKeyTable'

      describe('with configuration', () => {
        before(async () => {
          tracer = require('../../dd-trace')
          tracer.init()
          await agent.load()
          await agent.close({ ritmReset: false, wipe: true })
          await agent.load(
            'aws-sdk',
            {},
            {
              cloudPayloadTagging: {
                requestsEnabled: true,
                responsesEnabled: true,
                request: '$.Item.name',
                response: '$.Attributes,$.Item.data',
                maxDepth: 5
              }
            }
          )
          AWS = require(`../../../versions/${dynamoClientName}@${version}`).get()
          dynamo = new AWS.DynamoDB({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' })

          const deleteTable = async tableName => {
            if (dynamoClientName === '@aws-sdk/client-dynamodb') {
              try {
                await dynamo.deleteTable({ TableName: tableName })
                await new Promise(resolve => setTimeout(resolve, 1000))
              } catch (err) {
                if (err.name !== 'ResourceNotFoundException') {
                  throw err
                }
              }
            } else {
              try {
                if (typeof dynamo.deleteTable({}).promise === 'function') {
                  await dynamo.deleteTable({ TableName: tableName }).promise()
                  await dynamo.waitFor('tableNotExists', { TableName: tableName }).promise()
                } else {
                  await new Promise((resolve, reject) => {
                    dynamo.deleteTable({ TableName: tableName }, (err) => {
                      if (err && err.code !== 'ResourceNotFoundException') {
                        reject(err)
                      } else {
                        resolve()
                      }
                    })
                  })
                }
              } catch (err) {
                if (err.code !== 'ResourceNotFoundException') {
                  throw err
                }
              }
            }
          }

          const createTable = async (params) => {
            if (dynamoClientName === '@aws-sdk/client-dynamodb') {
              await dynamo.createTable(params)
            } else {
              await new Promise((resolve, reject) => {
                dynamo.createTable(params, (err, data) => {
                  if (err) reject(err)
                  else resolve(data)
                })
              })
            }
          }

          // Delete existing tables
          await Promise.all([
            deleteTable(oneKeyTableName),
            deleteTable(twoKeyTableName)
          ])

          // Create tables
          await Promise.all([
            createTable({
              TableName: oneKeyTableName,
              KeySchema: [{ AttributeName: 'name', KeyType: 'HASH' }],
              AttributeDefinitions: [{ AttributeName: 'name', AttributeType: 'S' }],
              ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
            }),
            createTable({
              TableName: twoKeyTableName,
              KeySchema: [
                { AttributeName: 'id', KeyType: 'HASH' },
                { AttributeName: 'binary', KeyType: 'RANGE' }
              ],
              AttributeDefinitions: [
                { AttributeName: 'id', AttributeType: 'N' },
                { AttributeName: 'binary', AttributeType: 'B' }
              ],
              ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
            })
          ])
        })

        function promisify (fn) {
          return function (...args) {
            const boundFn = typeof fn === 'function' ? fn.bind(dynamo) : fn

            // For AWS SDK v3, it's already promise-based
            if (moduleName === '@aws-sdk/smithy-client') {
              return boundFn(...args)
            }

            // For AWS SDK v2, we need to promisify the function
            return util.promisify(boundFn)(...args)
          }
        }

        after(async () => {
          await resetLocalStackDynamo()
          return agent.close({ ritmReset: false })
        })

        describe('with payload tagging', () => {
          it('adds request and response payloads as flattened tags for putItem', async () => {
            const agentPromise = agent.assertSomeTraces(traces => {
              const span = traces[0][0]

              expect(span.resource).to.equal(`putItem ${oneKeyTableName}`)
              expect(span.meta).to.include({
                'aws.dynamodb.table_name': oneKeyTableName,
                aws_service: 'DynamoDB',
                region: 'us-east-1',
                'aws.request.body.TableName': oneKeyTableName,
                'aws.request.body.Item.name': 'redacted',
                'aws.request.body.Item.data.S': 'test-data'
              })
            })

            const operation = () => promisify(dynamo.putItem)({
              TableName: oneKeyTableName,
              Item: {
                name: { S: 'test-name' },
                data: { S: 'test-data' }
              }
            })

            await Promise.all([agentPromise, operation()])
          })

          it('adds request and response payloads as flattened tags for updateItem', async () => {
            const agentPromise = agent.assertSomeTraces(traces => {
              const span = traces[0][0]

              expect(span.resource).to.equal(`updateItem ${oneKeyTableName}`)
              expect(span.meta).to.include({
                'aws.dynamodb.table_name': oneKeyTableName,
                aws_service: 'DynamoDB',
                region: 'us-east-1',
                'aws.request.body.TableName': oneKeyTableName,
                'aws.request.body.Key.name.S': 'test-name',
                'aws.request.body.AttributeUpdates.data.Value.S': 'updated-data'
              })
            })

            const operation = () => promisify(dynamo.updateItem)({
              TableName: oneKeyTableName,
              Key: {
                name: { S: 'test-name' }
              },
              AttributeUpdates: {
                data: {
                  Action: 'PUT',
                  Value: { S: 'updated-data' }
                }
              }
            })

            await Promise.all([agentPromise, operation()])
          })

          it('adds request and response payloads as flattened tags for deleteItem', async () => {
            const agentPromise = agent.assertSomeTraces(traces => {
              const span = traces[0][0]

              expect(span.resource).to.equal(`deleteItem ${oneKeyTableName}`)
              expect(span.meta).to.include({
                'aws.dynamodb.table_name': oneKeyTableName,
                aws_service: 'DynamoDB',
                region: 'us-east-1',
                'aws.request.body.TableName': oneKeyTableName,
                'aws.request.body.Key.name.S': 'test-name'
              })
            })

            const operation = () => promisify(dynamo.deleteItem)({
              TableName: oneKeyTableName,
              Key: {
                name: { S: 'test-name' }
              }
            })

            await Promise.all([agentPromise, operation()])
          })

          it('adds request and response payloads as flattened tags for getItem', async () => {
            // First put an item for later retrieval
            await promisify(dynamo.putItem)({
              TableName: oneKeyTableName,
              Item: {
                name: { S: 'test-get-name' },
                data: { S: 'test-get-data' }
              }
            })

            // Wait a bit to ensure the put completes
            await wait(100)

            const agentPromise = agent.assertSomeTraces(traces => {
              const span = traces[0][0]

              expect(span.resource).to.equal(`getItem ${oneKeyTableName}`)
              expect(span.meta).to.include({
                'aws.dynamodb.table_name': oneKeyTableName,
                aws_service: 'DynamoDB',
                region: 'us-east-1',
                'aws.request.body.TableName': oneKeyTableName,
                'aws.request.body.Key.name.S': 'test-get-name',
                'aws.response.body.Item.name.S': 'test-get-name',
                'aws.response.body.Item.data': 'redacted'
              })
            })

            const operation = () => promisify(dynamo.getItem)({
              TableName: oneKeyTableName,
              Key: {
                name: { S: 'test-get-name' }
              }
            })

            await Promise.all([agentPromise, operation()])
          })
        })

        describe('span pointers', () => {
          beforeEach(async () => {
            await agent.close({ ritmReset: false, wipe: true })
          })

          async function testSpanPointers ({ env, expectedHashes, operation }) {
            if (env) {
              process.env.DD_TRACE_DYNAMODB_TABLE_PRIMARY_KEYS = env
            } else {
              delete process.env.DD_TRACE_DYNAMODB_TABLE_PRIMARY_KEYS
            }

            await agent.load('aws-sdk')
            AWS = require(`../../../versions/${dynamoClientName}@${version}`).get()
            dynamo = new AWS.DynamoDB({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' })

            let expectedLength = 0
            if (expectedHashes) {
              expectedLength = Array.isArray(expectedHashes) ? expectedHashes.length : 1
            }
            const agentPromise = agent.assertSomeTraces(traces => {
              const span = traces[0][0]
              const links = JSON.parse(span.meta?.['_dd.span_links'] || '[]')

              expect(links).to.have.lengthOf(expectedLength)

              if (expectedHashes) {
                if (Array.isArray(expectedHashes)) {
                  expectedHashes.forEach((hash, i) => {
                    expect(links[i].attributes['ptr.hash']).to.equal(hash)
                  })
                } else {
                  expect(links[0].attributes).to.deep.equal({
                    'ptr.kind': DYNAMODB_PTR_KIND,
                    'ptr.dir': SPAN_POINTER_DIRECTION.DOWNSTREAM,
                    'ptr.hash': expectedHashes,
                    'link.kind': 'span-pointer'
                  })
                }
              }
            })

            DynamoDb.dynamoPrimaryKeyConfig = null

            await Promise.all([agentPromise, operation()])
          }

          describe('1-key table', () => {
            it('should add span pointer for putItem when config is valid', () => {
              return testSpanPointers({
                env: '{"OneKeyTable": ["name"]}',
                expectedHashes: '27f424c8202ab35efbf8b0b444b1928f',
                operation () {
                  return promisify(dynamo.putItem)({
                    TableName: oneKeyTableName,
                    Item: {
                      name: { S: 'test1' },
                      foo: { S: 'bar1' }
                    }
                  })
                }
              })
            })

            it('should not add links or error for putItem when config is invalid', function () {
              return testSpanPointers({
                env: '{"DifferentTable": ["test"]}',
                operation () {
                  return promisify(dynamo.putItem)({
                    TableName: oneKeyTableName,
                    Item: {
                      name: { S: 'test2' },
                      foo: { S: 'bar2' }
                    }
                  })
                }
              })
            })

            it('should not add links or error for putItem when config is missing', function () {
              return testSpanPointers({
                env: null,
                operation () {
                  return promisify(dynamo.putItem)({
                    TableName: oneKeyTableName,
                    Item: {
                      name: { S: 'test3' },
                      foo: { S: 'bar3' }
                    }
                  })
                }
              })
            })

            it('should add span pointer for updateItem', function () {
              return testSpanPointers({
                expectedHashes: '27f424c8202ab35efbf8b0b444b1928f',
                operation () {
                  return promisify(dynamo.updateItem)({
                    TableName: oneKeyTableName,
                    Key: { name: { S: 'test1' } },
                    AttributeUpdates: {
                      foo: {
                        Action: 'PUT',
                        Value: { S: 'bar4' }
                      }
                    }
                  })
                }
              })
            })

            it('should add span pointer for deleteItem', async function () {
              return testSpanPointers({
                expectedHashes: '27f424c8202ab35efbf8b0b444b1928f',
                operation () {
                  return promisify(dynamo.deleteItem)({
                    TableName: oneKeyTableName,
                    Key: { name: { S: 'test1' } }
                  })
                }
              })
            })

            it('should add span pointers for transactWriteItems', async function () {
              // Skip for older versions that don't support transactWriteItems
              if (typeof dynamo.transactWriteItems !== 'function') {
                return this.skip()
              }

              return testSpanPointers({
                env: '{"OneKeyTable": ["name"]}',
                expectedHashes: [
                  '955ab85fc7d1d63fe4faf18696514f13',
                  '856c95a173d9952008a70283175041fc',
                  '9682c132f1900106a792f166d0619e0b'
                ],
                operation () {
                  return promisify(dynamo.transactWriteItems)({
                    TransactItems: [
                      {
                        Put: {
                          TableName: oneKeyTableName,
                          Item: {
                            name: { S: 'test4' },
                            foo: { S: 'bar4' }
                          }
                        }
                      },
                      {
                        Update: {
                          TableName: oneKeyTableName,
                          Key: { name: { S: 'test2' } },
                          UpdateExpression: 'SET foo = :newfoo',
                          ExpressionAttributeValues: {
                            ':newfoo': { S: 'bar5' }
                          }
                        }
                      },
                      {
                        Delete: {
                          TableName: oneKeyTableName,
                          Key: { name: { S: 'test3' } }
                        }
                      }
                    ]
                  })
                }
              })
            })

            it('should add span pointers for batchWriteItem', function () {
              // Skip for older versions that don't support batchWriteItem
              if (typeof dynamo.batchWriteItem !== 'function') {
                return this.skip()
              }

              return testSpanPointers({
                env: '{"OneKeyTable": ["name"]}',
                expectedHashes: [
                  '955ab85fc7d1d63fe4faf18696514f13',
                  '9682c132f1900106a792f166d0619e0b'
                ],
                operation () {
                  return promisify(dynamo.batchWriteItem)({
                    RequestItems: {
                      [oneKeyTableName]: [
                        {
                          PutRequest: {
                            Item: {
                              name: { S: 'test4' },
                              foo: { S: 'bar4' }
                            }
                          }
                        },
                        {
                          DeleteRequest: {
                            Key: {
                              name: { S: 'test3' }
                            }
                          }
                        }
                      ]
                    }
                  })
                }
              })
            })
          })

          describe('2-key table', () => {
            it('should add span pointer for putItem when config is valid', function () {
              return testSpanPointers({
                env: '{"TwoKeyTable": ["id", "binary"]}',
                expectedHashes: 'cc32f0e49ee05d3f2820ccc999bfe306',
                operation () {
                  return promisify(dynamo.putItem)({
                    TableName: twoKeyTableName,
                    Item: {
                      id: { N: '1' },
                      binary: { B: Buffer.from('Hello world 1') }
                    }
                  })
                }
              })
            })

            it('should not add links or error for putItem when config is invalid', function () {
              return testSpanPointers({
                env: '{"DifferentTable": ["test"]}',
                operation () {
                  return promisify(dynamo.putItem)({
                    TableName: twoKeyTableName,
                    Item: {
                      id: { N: '2' },
                      binary: { B: Buffer.from('Hello world 2') }
                    }
                  })
                }
              })
            })

            it('should not add links or error for putItem when config is missing', function () {
              return testSpanPointers({
                operation () {
                  return promisify(dynamo.putItem)({
                    TableName: twoKeyTableName,
                    Item: {
                      id: { N: '3' },
                      binary: { B: Buffer.from('Hello world 3') }
                    }
                  })
                }
              })
            })

            it('should add span pointer for updateItem', async function () {
              await dynamo.putItem({
                TableName: twoKeyTableName,
                Item: {
                  id: { N: '100' },
                  binary: { B: Buffer.from('abc') }
                }
              })
              await wait(100)
              return testSpanPointers({
                env: '{"TwoKeyTable": ["id", "binary"]}',
                expectedHashes: '5dac7d25254d596482a3c2c187e51046',
                operation () {
                  return promisify(dynamo.updateItem)({
                    TableName: twoKeyTableName,
                    Key: {
                      id: { N: '100' },
                      binary: { B: Buffer.from('abc') }
                    },
                    AttributeUpdates: {
                      someOtherField: {
                        Action: 'PUT',
                        Value: { S: 'new value' }
                      }
                    }
                  })
                }
              })
            })

            it('should add span pointer for deleteItem', async function () {
              await dynamo.putItem({
                TableName: twoKeyTableName,
                Item: {
                  id: { N: '200' },
                  binary: { B: Buffer.from('Hello world') }
                }
              })
              await wait(100)
              return testSpanPointers({
                env: '{"TwoKeyTable": ["id", "binary"]}',
                expectedHashes: 'c356b0dd48c734d889e95122750c2679',
                operation () {
                  return promisify(dynamo.deleteItem)({
                    TableName: twoKeyTableName,
                    Key: {
                      id: { N: '200' },
                      binary: { B: Buffer.from('Hello world') }
                    }
                  })
                }
              })
            })

            it('should add span pointers for transactWriteItems', function () {
              // Skip for older versions that don't support transactWriteItems
              if (typeof dynamo.transactWriteItems !== 'function') {
                return this.skip()
              }

              return testSpanPointers({
                env: '{"TwoKeyTable": ["id", "binary"]}',
                expectedHashes: [
                  'dd071963cd90e4b3088043f0b9a9f53c',
                  '7794824f72d673ac7844353bc3ea25d9',
                  '8a6f801cc4e7d1d5e0dd37e0904e6316'
                ],
                operation () {
                  return promisify(dynamo.transactWriteItems)({
                    TransactItems: [
                      {
                        Put: {
                          TableName: twoKeyTableName,
                          Item: {
                            id: { N: '4' },
                            binary: { B: Buffer.from('Hello world 4') }
                          }
                        }
                      },
                      {
                        Update: {
                          TableName: twoKeyTableName,
                          Key: {
                            id: { N: '2' },
                            binary: { B: Buffer.from('Hello world 2') }
                          },
                          UpdateExpression: 'SET someOtherField = :newvalue',
                          ExpressionAttributeValues: {
                            ':newvalue': { S: 'new value' }
                          }
                        }
                      },
                      {
                        Delete: {
                          TableName: twoKeyTableName,
                          Key: {
                            id: { N: '3' },
                            binary: { B: Buffer.from('Hello world 3') }
                          }
                        }
                      }
                    ]
                  })
                }
              })
            })

            it('should add span pointers for batchWriteItem', function () {
              // Skip for older versions that don't support batchWriteItem
              if (typeof dynamo.batchWriteItem !== 'function') {
                return this.skip()
              }

              return testSpanPointers({
                env: '{"TwoKeyTable": ["id", "binary"]}',
                expectedHashes: [
                  '1f64650acbe1ae4d8413049c6bd9bbe8',
                  '8a6f801cc4e7d1d5e0dd37e0904e6316'
                ],
                operation () {
                  return promisify(dynamo.batchWriteItem)({
                    RequestItems: {
                      [twoKeyTableName]: [
                        {
                          PutRequest: {
                            Item: {
                              id: { N: '5' },
                              binary: { B: Buffer.from('Hello world 5') }
                            }
                          }
                        },
                        {
                          DeleteRequest: {
                            Key: {
                              id: { N: '3' },
                              binary: { B: Buffer.from('Hello world 3') }
                            }
                          }
                        }
                      ]
                    }
                  })
                }
              })
            })
          })
        })
      })
    })

    describe('getPrimaryKeyConfig', () => {
      let dynamoDbInstance

      beforeEach(() => {
        dynamoDbInstance = new DynamoDb()
        dynamoDbInstance.dynamoPrimaryKeyConfig = null
        dynamoDbInstance._tracerConfig = {}
      })

      it('should return cached config if available', () => {
        const cachedConfig = { Table1: ['key1'] }
        dynamoDbInstance.dynamoPrimaryKeyConfig = cachedConfig

        const result = dynamoDbInstance.getPrimaryKeyConfig()
        expect(result).to.equal(cachedConfig)
      })

      it('should return undefined when config str is missing', () => {
        const result = dynamoDbInstance.getPrimaryKeyConfig()
        expect(result).to.be.undefined
      })

      it('should parse valid config with single table', () => {
        const configStr = '{"Table1": ["key1", "key2"]}'
        dynamoDbInstance._tracerConfig = { trace: { dynamoDb: { tablePrimaryKeys: configStr } } }

        const result = dynamoDbInstance.getPrimaryKeyConfig()
        expect(result).to.deep.equal({
          Table1: ['key1', 'key2']
        })
      })

      it('should parse valid config with multiple tables', () => {
        const configStr = '{"Table1": ["key1"], "Table2": ["key2", "key3"]}'
        dynamoDbInstance._tracerConfig = { trace: { dynamoDb: { tablePrimaryKeys: configStr } } }

        const result = dynamoDbInstance.getPrimaryKeyConfig()
        expect(result).to.deep.equal({
          Table1: ['key1'],
          Table2: ['key2', 'key3']
        })
      })

      it('should fail for invalid entries', () => {
        const configStr = '{"Table1": {"key1": 42}, "Table42": ["key1"], "Table2": ["key1", "key2", "key3"]}'
        dynamoDbInstance._tracerConfig = { trace: { dynamoDb: { tablePrimaryKeys: configStr } } }

        const result = dynamoDbInstance.getPrimaryKeyConfig()
        expect(result).to.deep.equal({
          Table42: ['key1']
        })
      })
    })

    describe('calculatePutItemHash', () => {
      it('generates correct hash for single string key', () => {
        const tableName = 'UserTable'
        const item = { userId: { S: 'user123' }, name: { S: 'John' } }
        const keyConfig = { UserTable: ['userId'] }

        const actualHash = DynamoDb.calculatePutItemHash(tableName, item, keyConfig)
        const expectedHash = generatePointerHash([tableName, 'userId', 'user123', '', ''])
        expect(actualHash).to.equal(expectedHash)
      })

      it('generates correct hash for single number key', () => {
        const tableName = 'OrderTable'
        const item = { orderId: { N: '98765' }, total: { N: '50.00' } }
        const keyConfig = { OrderTable: ['orderId'] }

        const actualHash = DynamoDb.calculatePutItemHash(tableName, item, keyConfig)
        const expectedHash = generatePointerHash([tableName, 'orderId', '98765', '', ''])
        expect(actualHash).to.equal(expectedHash)
      })

      it('generates correct hash for single binary key', () => {
        const tableName = 'BinaryTable'
        const binaryData = Buffer.from([1, 2, 3])
        const item = { binaryId: { B: binaryData }, data: { S: 'test' } }
        const keyConfig = { BinaryTable: ['binaryId'] }

        const actualHash = DynamoDb.calculatePutItemHash(tableName, item, keyConfig)
        const expectedHash = generatePointerHash([tableName, 'binaryId', binaryData, '', ''])
        expect(actualHash).to.equal(expectedHash)
      })

      it('generates correct hash for string-string key', () => {
        const tableName = 'UserEmailTable'
        const item = {
          userId: { S: 'user123' },
          email: { S: 'test@example.com' },
          verified: { BOOL: true }
        }
        const keyConfig = { UserEmailTable: ['userId', 'email'] }

        const actualHash = DynamoDb.calculatePutItemHash(tableName, item, keyConfig)
        const expectedHash = generatePointerHash([tableName, 'email', 'test@example.com', 'userId', 'user123'])
        expect(actualHash).to.equal(expectedHash)
      })

      it('generates correct hash for string-number key', () => {
        const tableName = 'UserActivityTable'
        const item = {
          userId: { S: 'user123' },
          timestamp: { N: '1234567' },
          action: { S: 'login' }
        }
        const keyConfig = { UserActivityTable: ['userId', 'timestamp'] }

        const actualHash = DynamoDb.calculatePutItemHash(tableName, item, keyConfig)
        const expectedHash = generatePointerHash([tableName, 'timestamp', '1234567', 'userId', 'user123'])
        expect(actualHash).to.equal(expectedHash)
      })

      it('generates correct hash for binary-binary key', () => {
        const tableName = 'BinaryTable'
        const binary1 = Buffer.from('abc')
        const binary2 = Buffer.from('1ef230')
        const item = {
          key1: { B: binary1 },
          key2: { B: binary2 },
          data: { S: 'test' }
        }
        const keyConfig = { BinaryTable: ['key1', 'key2'] }

        const actualHash = DynamoDb.calculatePutItemHash(tableName, item, keyConfig)
        const expectedHash = generatePointerHash([tableName, 'key1', binary1, 'key2', binary2])
        expect(actualHash).to.equal(expectedHash)
      })

      it('generates unique hashes for different tables', () => {
        const item = { userId: { S: 'user123' } }
        const keyConfig = {
          Table1: ['userId'],
          Table2: ['userId']
        }

        const hash1 = DynamoDb.calculatePutItemHash('Table1', item, keyConfig)
        const hash2 = DynamoDb.calculatePutItemHash('Table2', item, keyConfig)
        expect(hash1).to.not.equal(hash2)
      })

      describe('edge cases', () => {
        it('returns undefined for unknown table', () => {
          const tableName = 'UnknownTable'
          const item = { userId: { S: 'user123' } }
          const keyConfig = { KnownTable: ['userId'] }

          const result = DynamoDb.calculatePutItemHash(tableName, item, keyConfig)
          expect(result).to.be.undefined
        })

        it('returns undefined for empty primary key config', () => {
          const tableName = 'UserTable'
          const item = { userId: { S: 'user123' } }

          const result = DynamoDb.calculatePutItemHash(tableName, item, {})
          expect(result).to.be.undefined
        })

        it('returns undefined when missing attributes in item', () => {
          const tableName = 'UserTable'
          const item = { someOtherField: { S: 'value' } }
          const keyConfig = { UserTable: ['userId'] }

          const actualHash = DynamoDb.calculatePutItemHash(tableName, item, keyConfig)
          expect(actualHash).to.be.undefined
        })

        it('returns undefined for empty keyConfig', () => {
          const result = DynamoDb.calculatePutItemHash('TestTable', {}, {})
          expect(result).to.be.undefined
        })

        it('returns undefined for undefined keyConfig', () => {
          const result = DynamoDb.calculatePutItemHash('TestTable', {}, undefined)
          expect(result).to.be.undefined
        })
      })
    })

    describe('calculateHashWithKnownKeys', () => {
      it('generates correct hash for single string key', () => {
        const tableName = 'UserTable'
        const keys = { userId: { S: 'user123' } }
        const actualHash = DynamoDb.calculateHashWithKnownKeys(tableName, keys)
        const expectedHash = generatePointerHash([tableName, 'userId', 'user123', '', ''])
        expect(actualHash).to.equal(expectedHash)
      })

      it('generates correct hash for single number key', () => {
        const tableName = 'OrderTable'
        const keys = { orderId: { N: '98765' } }
        const actualHash = DynamoDb.calculateHashWithKnownKeys(tableName, keys)
        const expectedHash = generatePointerHash([tableName, 'orderId', '98765', '', ''])
        expect(actualHash).to.equal(expectedHash)
      })

      it('generates correct hash for single binary key', () => {
        const tableName = 'BinaryTable'
        const binaryData = Buffer.from([1, 2, 3])
        const keys = { binaryId: { B: binaryData } }
        const actualHash = DynamoDb.calculateHashWithKnownKeys(tableName, keys)
        const expectedHash = generatePointerHash([tableName, 'binaryId', binaryData, '', ''])
        expect(actualHash).to.equal(expectedHash)
      })

      it('generates correct hash for string-string key', () => {
        const tableName = 'UserEmailTable'
        const keys = {
          userId: { S: 'user123' },
          email: { S: 'test@example.com' }
        }
        const actualHash = DynamoDb.calculateHashWithKnownKeys(tableName, keys)
        const expectedHash = generatePointerHash([tableName, 'email', 'test@example.com', 'userId', 'user123'])
        expect(actualHash).to.equal(expectedHash)
      })

      it('generates correct hash for string-number key', () => {
        const tableName = 'UserActivityTable'
        const keys = {
          userId: { S: 'user123' },
          timestamp: { N: '1234567' }
        }
        const actualHash = DynamoDb.calculateHashWithKnownKeys(tableName, keys)
        const expectedHash = generatePointerHash([tableName, 'timestamp', '1234567', 'userId', 'user123'])
        expect(actualHash).to.equal(expectedHash)
      })

      it('generates correct hash for binary-binary key', () => {
        const tableName = 'BinaryTable'
        const binary1 = Buffer.from('abc')
        const binary2 = Buffer.from('1ef230')
        const keys = {
          key1: { B: binary1 },
          key2: { B: binary2 }
        }
        const actualHash = DynamoDb.calculateHashWithKnownKeys(tableName, keys)
        const expectedHash = generatePointerHash([tableName, 'key1', binary1, 'key2', binary2])
        expect(actualHash).to.equal(expectedHash)
      })

      it('generates unique hashes', () => {
        const keys = { userId: { S: 'user123' } }
        const hash1 = DynamoDb.calculateHashWithKnownKeys('Table1', keys)
        const hash2 = DynamoDb.calculateHashWithKnownKeys('Table2', keys)
        expect(hash1).to.not.equal(hash2)
      })

      describe('edge cases', () => {
        it('handles empty keys object', () => {
          const tableName = 'UserTable'
          const hash = DynamoDb.calculateHashWithKnownKeys(tableName, {})
          expect(hash).to.be.undefined
        })

        it('handles invalid key types', () => {
          const tableName = 'UserTable'
          const keys = { userId: { INVALID: 'user123' } }
          const hash = DynamoDb.calculateHashWithKnownKeys(tableName, keys)
          expect(hash).to.be.undefined
        })

        it('handles null keys object', () => {
          const hash = DynamoDb.calculateHashWithKnownKeys('TestTable', null)
          expect(hash).to.be.undefined
        })

        it('handles undefined keys object', () => {
          const hash = DynamoDb.calculateHashWithKnownKeys('TestTable', undefined)
          expect(hash).to.be.undefined
        })

        it('handles mixed valid and invalid key types', () => {
          const keys = {
            validKey: { S: 'test' },
            invalidKey: { INVALID: 'value' }
          }
          const hash = DynamoDb.calculateHashWithKnownKeys('TestTable', keys)
          expect(hash).to.be.undefined
        })
      })
    })
  })
})
