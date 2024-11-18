'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { setup } = require('./spec_helpers')
const axios = require('axios')
const { DYNAMODB_PTR_KIND, SPAN_POINTER_DIRECTION } = require('../../dd-trace/src/constants')
const DynamoDb = require('../src/services/dynamodb')

/* eslint-disable no-console */
async function resetLocalStackS3 () {
  try {
    await axios.post('http://localhost:4566/reset')
    console.log('LocalStack S3 reset successful')
  } catch (error) {
    console.error('Error resetting LocalStack S3:', error.message)
  }
}

describe('Plugin', () => {
  describe('aws-sdk (dynamodb)', function () {
    setup()

    withVersions('aws-sdk', [/* 'aws-sdk', */'@aws-sdk/smithy-client'], (version, moduleName) => {
      // Test both cases: tables with only partition key and with partition+sort key.
      const oneKeyTableName = 'OneKeyTable'
      const twoKeyTableName = 'TwoKeyTable'

      let tracer
      let AWS
      let dynamo

      const dynamoClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-dynamodb' : 'aws-sdk'
      describe('with configuration', () => {
        before(() => {
          tracer = require('../../dd-trace')
          tracer.init()
          return agent.load('aws-sdk')
        })

        before(async () => {
          AWS = require(`../../../versions/${dynamoClientName}@${version}`).get()
          dynamo = new AWS.DynamoDB({ endpoint: 'http://127.0.0.1:4566', s3ForcePathStyle: true, region: 'us-east-1' })

          // Fix for LocationConstraint issue - only for SDK v2
          if (dynamoClientName === 'aws-sdk') {
            dynamo.api.globalEndpoint = '127.0.0.1'
          }

          await dynamo.createTable({
            TableName: oneKeyTableName,
            KeySchema: [{ AttributeName: 'name', KeyType: 'HASH' }],
            AttributeDefinitions: [{ AttributeName: 'name', AttributeType: 'S' }],
            ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
          })
          await dynamo.createTable({
            TableName: twoKeyTableName,
            KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }, { AttributeName: 'binary', KeyType: 'RANGE' }],
            AttributeDefinitions: [
              { AttributeName: 'id', AttributeType: 'N' }, { AttributeName: 'binary', AttributeType: 'B' }
            ],
            ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
          })
        })

        after(async () => {
          try {
            await dynamo.deleteTable({ TableName: oneKeyTableName })
          } catch {}
          try {
            await dynamo.deleteTable({ TableName: twoKeyTableName })
          } catch {}

          await resetLocalStackS3()
          return agent.close({ ritmReset: false })
        })

        describe('span pointers', () => {
          beforeEach(() => {
            DynamoDb.dynamoPrimaryKeyConfig = null
            process.env.DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS = null
          })

          function testSpanPointers({ expectedLength = 1, expectedHashes, operation }) {
            return (done) => {
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
                  done()
                } catch (error) {
                  return done(error)
                }
              }).catch(done)

              operation((err) => {
                if (err) return done(err)
              })
            }
          }

          describe('1-key table', () => {
            it('should add span pointer for putItem when config is valid',
              testSpanPointers({
                expectedHashes: '27f424c8202ab35efbf8b0b444b1928f',
                operation: (callback) => {
                  process.env.DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS =
                    '{"OneKeyTable": ["name"], "TwoKeyTable": ["id", "binary"]}'
                  dynamo.putItem({
                    TableName: oneKeyTableName,
                    Item: {
                      name: { S: 'test1' },
                      foo: { S: 'bar1' }
                    }
                  }, callback)
                }
              })
            )

            it('should not add links or error for putItem when config is invalid',
              testSpanPointers({
                expectedLength: 0,
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
            )

            it('should not add links or error for putItem when config is missing',
              testSpanPointers({
                expectedLength: 0,
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
            )

            it('should add span pointer for updateItem',
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
            )

            it('should add span pointer for deleteItem',
              testSpanPointers({
                expectedHashes: '27f424c8202ab35efbf8b0b444b1928f',
                operation: (callback) => {
                  dynamo.deleteItem({
                    TableName: oneKeyTableName,
                    Key: { name: { S: 'test1' } }
                  }, callback)
                }
              })
            )

            it('should add span pointers for transactWriteItems',
              testSpanPointers({
                expectedLength: 3,
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
                          AttributeUpdates: {
                            foo: {
                              Action: 'PUT',
                              Value: { S: 'bar5' }
                            }
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
            )

            it('should add span pointers for batchWriteItem',
              testSpanPointers({
                expectedLength: 2,
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
            )
          })

          describe('2-key table', () => {
            it('should add span pointer for putItem when config is valid',
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
            )

            it('should not add links or error for putItem when config is invalid',
              testSpanPointers({
                expectedLength: 0,
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
            )

            it('should not add links or error for putItem when config is missing',
              testSpanPointers({
                expectedLength: 0,
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
            )

            it('should add span pointer for updateItem',
              testSpanPointers({
                expectedHashes: '8a6f801cc4e7d1d5e0dd37e0904e6316',
                operation: (callback) => {
                  dynamo.updateItem({
                    TableName: twoKeyTableName,
                    Key: {
                      id: { N: '3' },
                      binary: { B: Buffer.from('Hello world 3') }
                    },
                    AttributeUpdates: {
                      someOtherField: {
                        Action: 'PUT',
                        Value: { S: 'new value' }
                      }
                    }
                  }, callback)
                }
              })
            )

            it('should add span pointer for deleteItem',
              testSpanPointers({
                expectedHashes: '8a6f801cc4e7d1d5e0dd37e0904e6316',
                operation: (callback) => {
                  dynamo.deleteItem({
                    TableName: twoKeyTableName,
                    Key: {
                      id: { N: '3' },
                      binary: { B: Buffer.from('Hello world 3') }
                    }
                  }, callback)
                }
              })
            )

            it('should add span pointers for transactWriteItems',
              testSpanPointers({
                expectedLength: 3,
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
            )

            it('should add span pointers for batchWriteItem',
              testSpanPointers({
                expectedLength: 2,
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
            )
          })
        })

        describe('DynamoDb.getPrimaryKeyConfig', () => {
          beforeEach(() => {
            DynamoDb.dynamoPrimaryKeyConfig = null
            delete process.env.DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS
          })

          it('should return cached config if available', () => {
            const cachedConfig = { Table1: new Set(['key1']) }
            DynamoDb.dynamoPrimaryKeyConfig = cachedConfig

            const result = DynamoDb.getPrimaryKeyConfig()
            expect(result).to.equal(cachedConfig)
          })

          it('should return null when env var is missing', () => {
            const result = DynamoDb.getPrimaryKeyConfig()
            expect(result).to.be.null
          })

          it('should parse valid config with single table', () => {
            process.env.DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS = '{"Table1": ["key1", "key2"]}'

            const result = DynamoDb.getPrimaryKeyConfig()
            expect(result).to.deep.equal({
              Table1: new Set(['key1', 'key2'])
            })
          })

          it('should parse valid config with multiple tables', () => {
            process.env.DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS =
              '{"Table1": ["key1"], "Table2": ["key2", "key3"]}'

            const result = DynamoDb.getPrimaryKeyConfig()
            expect(result).to.deep.equal({
              Table1: new Set(['key1']),
              Table2: new Set(['key2', 'key3'])
            })
          })

          it('should skip tables with empty primary keys array', () => {
            process.env.DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS =
              '{"Table1": ["key1"], "Table2": []}'

            const result = DynamoDb.getPrimaryKeyConfig()
            expect(result).to.deep.equal({
              Table1: new Set(['key1'])
            })
          })

          it('should skip tables with non-array primary keys', () => {
            process.env.DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS =
              '{"Table1": ["key1"], "Table2": "invalid"}'

            const result = DynamoDb.getPrimaryKeyConfig()
            expect(result).to.deep.equal({
              Table1: new Set(['key1'])
            })
          })

          it('should return null for invalid JSON', () => {
            process.env.DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS = 'invalid json'

            const result = DynamoDb.getPrimaryKeyConfig()
            expect(result).to.be.null
          })

          it('should return empty object for empty JSON object', () => {
            process.env.DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS = '{}'

            const result = DynamoDb.getPrimaryKeyConfig()
            expect(result).to.deep.equal({})
          })

          it('should cache the parsed config', () => {
            process.env.DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS = '{"Table1": ["key1"]}'

            const firstResult = DynamoDb.getPrimaryKeyConfig()
            process.env.DD_AWS_SDK_DYNAMODB_TABLE_PRIMARY_KEYS = '{"Table2": ["key2"]}'
            const secondResult = DynamoDb.getPrimaryKeyConfig()

            expect(firstResult).to.deep.equal(secondResult)
          })
        })
      })
    })
  })
})
