'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { setup } = require('./spec_helpers')
const axios = require('axios')
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
        before(() => {
          tracer = require('../../dd-trace')
          tracer.init()
          return agent.load('aws-sdk')
        })

        before(async () => {
          AWS = require(`../../../versions/${dynamoClientName}@${version}`).get()
          dynamo = new AWS.DynamoDB({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' })

          const deleteTable = async (tableName) => {
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
              if (typeof dynamo.createTable({}).promise === 'function') {
                await dynamo.createTable(params).promise()
              } else {
                await new Promise((resolve, reject) => {
                  dynamo.createTable(params, (err, data) => {
                    if (err) reject(err)
                    else resolve(data)
                  })
                })
              }
            }
          }

          // Delete existing tables
          await deleteTable(oneKeyTableName)
          await deleteTable(twoKeyTableName)

          // Create tables
          await createTable({
            TableName: oneKeyTableName,
            KeySchema: [{ AttributeName: 'name', KeyType: 'HASH' }],
            AttributeDefinitions: [{ AttributeName: 'name', AttributeType: 'S' }],
            ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
          })

          await createTable({
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
        })

        after(async () => {
          await resetLocalStackDynamo()
          return agent.close({ ritmReset: false })
        })

        describe('span pointers', () => {
          beforeEach(() => {
            DynamoDb.dynamoPrimaryKeyConfig = null
            delete process.env.DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS
          })

          function testSpanPointers ({ expectedHashes, operation }) {
            let expectedLength = 0
            if (expectedHashes) {
              expectedLength = Array.isArray(expectedHashes) ? expectedHashes.length : 1
            }
            return (done) => {
              operation((err) => {
                if (err) {
                  return done(err)
                }

                agent.use(traces => {
                  try {
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
                    return done()
                  } catch (error) {
                    return done(error)
                  }
                }).catch(error => {
                  done(error)
                })
              })
            }
          }

          describe('1-key table', () => {
            it('should add span pointer for putItem when config is valid', () => {
              testSpanPointers({
                expectedHashes: '27f424c8202ab35efbf8b0b444b1928f',
                operation: (callback) => {
                  process.env.DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS =
                    '{"OneKeyTable": ["name"]}'
                  dynamo.putItem({
                    TableName: oneKeyTableName,
                    Item: {
                      name: { S: 'test1' },
                      foo: { S: 'bar1' }
                    }
                  }, callback)
                }
              })
            })

            it('should not add links or error for putItem when config is invalid', () => {
              testSpanPointers({
                operation: (callback) => {
                  process.env.DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS = '{"DifferentTable": ["test"]}'
                  dynamo.putItem({
                    TableName: oneKeyTableName,
                    Item: {
                      name: { S: 'test2' },
                      foo: { S: 'bar2' }
                    }
                  }, callback)
                }
              })
            })

            it('should not add links or error for putItem when config is missing', () => {
              testSpanPointers({
                operation: (callback) => {
                  process.env.DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS = null
                  dynamo.putItem({
                    TableName: oneKeyTableName,
                    Item: {
                      name: { S: 'test3' },
                      foo: { S: 'bar3' }
                    }
                  }, callback)
                }
              })
            })

            it('should add span pointer for updateItem', () => {
              testSpanPointers({
                expectedHashes: '27f424c8202ab35efbf8b0b444b1928f',
                operation: (callback) => {
                  dynamo.updateItem({
                    TableName: oneKeyTableName,
                    Key: { name: { S: 'test1' } },
                    AttributeUpdates: {
                      foo: {
                        Action: 'PUT',
                        Value: { S: 'bar4' }
                      }
                    }
                  }, callback)
                }
              })
            })

            it('should add span pointer for deleteItem', () => {
              testSpanPointers({
                expectedHashes: '27f424c8202ab35efbf8b0b444b1928f',
                operation: (callback) => {
                  dynamo.deleteItem({
                    TableName: oneKeyTableName,
                    Key: { name: { S: 'test1' } }
                  }, callback)
                }
              })
            })

            it('should add span pointers for transactWriteItems', () => {
              // Skip for older versions that don't support transactWriteItems
              if (typeof dynamo.transactWriteItems !== 'function') {
                return
              }
              testSpanPointers({
                expectedHashes: [
                  '955ab85fc7d1d63fe4faf18696514f13',
                  '856c95a173d9952008a70283175041fc',
                  '9682c132f1900106a792f166d0619e0b'
                ],
                operation: (callback) => {
                  process.env.DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS = '{"OneKeyTable": ["name"]}'
                  dynamo.transactWriteItems({
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
                  }, callback)
                }
              })
            })

            it('should add span pointers for batchWriteItem', () => {
              // Skip for older versions that don't support batchWriteItem
              if (typeof dynamo.batchWriteItem !== 'function') {
                return
              }
              testSpanPointers({
                expectedHashes: [
                  '955ab85fc7d1d63fe4faf18696514f13',
                  '9682c132f1900106a792f166d0619e0b'
                ],
                operation: (callback) => {
                  process.env.DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS = '{"OneKeyTable": ["name"]}'
                  dynamo.batchWriteItem({
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
                  }, callback)
                }
              })
            })
          })

          describe('2-key table', () => {
            it('should add span pointer for putItem when config is valid', () => {
              testSpanPointers({
                expectedHashes: 'cc32f0e49ee05d3f2820ccc999bfe306',
                operation: (callback) => {
                  process.env.DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS = '{"TwoKeyTable": ["id", "binary"]}'
                  dynamo.putItem({
                    TableName: twoKeyTableName,
                    Item: {
                      id: { N: '1' },
                      binary: { B: Buffer.from('Hello world 1') }
                    }
                  }, callback)
                }
              })
            })

            it('should not add links or error for putItem when config is invalid', () => {
              testSpanPointers({
                operation: (callback) => {
                  process.env.DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS = '{"DifferentTable": ["test"]}'
                  dynamo.putItem({
                    TableName: twoKeyTableName,
                    Item: {
                      id: { N: '2' },
                      binary: { B: Buffer.from('Hello world 2') }
                    }
                  }, callback)
                }
              })
            })

            it('should not add links or error for putItem when config is missing', () => {
              testSpanPointers({
                operation: (callback) => {
                  process.env.DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS = null
                  dynamo.putItem({
                    TableName: twoKeyTableName,
                    Item: {
                      id: { N: '3' },
                      binary: { B: Buffer.from('Hello world 3') }
                    }
                  }, callback)
                }
              })
            })

            it('should add span pointer for updateItem', function (done) {
              dynamo.putItem({
                TableName: twoKeyTableName,
                Item: {
                  id: { N: '100' },
                  binary: { B: Buffer.from('abc') }
                }
              }, async function (err) {
                if (err) {
                  return done(err)
                }
                await new Promise(resolve => setTimeout(resolve, 100))
                testSpanPointers({
                  expectedHashes: '5dac7d25254d596482a3c2c187e51046',
                  operation: (callback) => {
                    dynamo.updateItem({
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
                    }, callback)
                  }
                })(done)
              })
            })

            it('should add span pointer for deleteItem', function (done) {
              dynamo.putItem({
                TableName: twoKeyTableName,
                Item: {
                  id: { N: '200' },
                  binary: { B: Buffer.from('Hello world') }
                }
              }, async function (err) {
                if (err) return done(err)
                await new Promise(resolve => setTimeout(resolve, 100))
                testSpanPointers({
                  expectedHashes: 'c356b0dd48c734d889e95122750c2679',
                  operation: (callback) => {
                    dynamo.deleteItem({
                      TableName: twoKeyTableName,
                      Key: {
                        id: { N: '200' },
                        binary: { B: Buffer.from('Hello world') }
                      }
                    }, callback)
                  }
                })(done)
              })
            })

            it('should add span pointers for transactWriteItems', () => {
              // Skip for older versions that don't support transactWriteItems
              if (typeof dynamo.transactWriteItems !== 'function') {
                return
              }
              testSpanPointers({
                expectedHashes: [
                  'dd071963cd90e4b3088043f0b9a9f53c',
                  '7794824f72d673ac7844353bc3ea25d9',
                  '8a6f801cc4e7d1d5e0dd37e0904e6316'
                ],
                operation: (callback) => {
                  process.env.DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS = '{"TwoKeyTable": ["id", "binary"]}'
                  dynamo.transactWriteItems({
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
                          AttributeUpdates: {
                            someOtherField: {
                              Action: 'PUT',
                              Value: { S: 'new value' }
                            }
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
                  }, callback)
                }
              })
            })

            it('should add span pointers for batchWriteItem', () => {
              // Skip for older versions that don't support batchWriteItem
              if (typeof dynamo.batchWriteItem !== 'function') {
                return
              }
              testSpanPointers({
                expectedHashes: [
                  '1f64650acbe1ae4d8413049c6bd9bbe8',
                  '8a6f801cc4e7d1d5e0dd37e0904e6316'
                ],
                operation: (callback) => {
                  process.env.DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS = '{"TwoKeyTable": ["id", "binary"]}'
                  dynamo.batchWriteItem({
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
                  }, callback)
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
        const cachedConfig = { Table1: new Set(['key1']) }
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
        dynamoDbInstance._tracerConfig = { aws: { dynamoDb: { tablePrimaryKeys: configStr } } }

        const result = dynamoDbInstance.getPrimaryKeyConfig()
        expect(result).to.deep.equal({
          Table1: new Set(['key1', 'key2'])
        })
      })

      it('should parse valid config with multiple tables', () => {
        const configStr = '{"Table1": ["key1"], "Table2": ["key2", "key3"]}'
        dynamoDbInstance._tracerConfig = { aws: { dynamoDb: { tablePrimaryKeys: configStr } } }

        const result = dynamoDbInstance.getPrimaryKeyConfig()
        expect(result).to.deep.equal({
          Table1: new Set(['key1']),
          Table2: new Set(['key2', 'key3'])
        })
      })
    })

    describe('calculatePutItemHash', () => {
      it('generates correct hash for single string key', () => {
        const tableName = 'UserTable'
        const item = { userId: { S: 'user123' }, name: { S: 'John' } }
        const keyConfig = { UserTable: new Set(['userId']) }

        const actualHash = DynamoDb.calculatePutItemHash(tableName, item, keyConfig)
        const expectedHash = generatePointerHash([tableName, 'userId', 'user123', '', ''])
        expect(actualHash).to.equal(expectedHash)
      })

      it('generates correct hash for single number key', () => {
        const tableName = 'OrderTable'
        const item = { orderId: { N: '98765' }, total: { N: '50.00' } }
        const keyConfig = { OrderTable: new Set(['orderId']) }

        const actualHash = DynamoDb.calculatePutItemHash(tableName, item, keyConfig)
        const expectedHash = generatePointerHash([tableName, 'orderId', '98765', '', ''])
        expect(actualHash).to.equal(expectedHash)
      })

      it('generates correct hash for single binary key', () => {
        const tableName = 'BinaryTable'
        const binaryData = Buffer.from([1, 2, 3])
        const item = { binaryId: { B: binaryData }, data: { S: 'test' } }
        const keyConfig = { BinaryTable: new Set(['binaryId']) }

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
        const keyConfig = { UserEmailTable: new Set(['userId', 'email']) }

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
        const keyConfig = { UserActivityTable: new Set(['userId', 'timestamp']) }

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
        const keyConfig = { BinaryTable: new Set(['key1', 'key2']) }

        const actualHash = DynamoDb.calculatePutItemHash(tableName, item, keyConfig)
        const expectedHash = generatePointerHash([tableName, 'key1', binary1, 'key2', binary2])
        expect(actualHash).to.equal(expectedHash)
      })

      it('generates unique hashes for different tables', () => {
        const item = { userId: { S: 'user123' } }
        const keyConfig = {
          Table1: new Set(['userId']),
          Table2: new Set(['userId'])
        }

        const hash1 = DynamoDb.calculatePutItemHash('Table1', item, keyConfig)
        const hash2 = DynamoDb.calculatePutItemHash('Table2', item, keyConfig)
        expect(hash1).to.not.equal(hash2)
      })

      describe('edge cases', () => {
        it('returns undefined for unknown table', () => {
          const tableName = 'UnknownTable'
          const item = { userId: { S: 'user123' } }
          const keyConfig = { KnownTable: new Set(['userId']) }

          const result = DynamoDb.calculatePutItemHash(tableName, item, keyConfig)
          expect(result).to.be.undefined
        })

        it('returns undefined for empty primary key config', () => {
          const tableName = 'UserTable'
          const item = { userId: { S: 'user123' } }

          const result = DynamoDb.calculatePutItemHash(tableName, item, {})
          expect(result).to.be.undefined
        })

        it('returns undefined for invalid primary key config', () => {
          const tableName = 'UserTable'
          const item = { userId: { S: 'user123' } }
          const invalidConfig = { UserTable: ['userId'] } // Array instead of Set

          const result = DynamoDb.calculatePutItemHash(tableName, item, invalidConfig)
          expect(result).to.be.undefined
        })

        it('returns undefined when missing attributes in item', () => {
          const tableName = 'UserTable'
          const item = { someOtherField: { S: 'value' } }
          const keyConfig = { UserTable: new Set(['userId']) }

          const actualHash = DynamoDb.calculatePutItemHash(tableName, item, keyConfig)
          expect(actualHash).to.be.undefined
        })

        it('returns undefined for Set with more than 2 keys', () => {
          const tableName = 'TestTable'
          const item = { key1: { S: 'value1' }, key2: { S: 'value2' }, key3: { S: 'value3' } }
          const keyConfig = { TestTable: new Set(['key1', 'key2', 'key3']) }

          const result = DynamoDb.calculatePutItemHash(tableName, item, keyConfig)
          expect(result).to.be.undefined
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
