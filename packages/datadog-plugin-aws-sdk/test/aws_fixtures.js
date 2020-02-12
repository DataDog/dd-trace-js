'use strict'

const fixtures = {}

fixtures['ddb'] = {
  AttributeDefinitions: [
    {
      AttributeName: 'CUSTOMER_ID',
      AttributeType: 'N'
    },
    {
      AttributeName: 'CUSTOMER_NAME',
      AttributeType: 'S'
    }
  ],
  KeySchema: [
    {
      AttributeName: 'CUSTOMER_ID',
      KeyType: 'HASH'
    },
    {
      AttributeName: 'CUSTOMER_NAME',
      KeyType: 'RANGE'
    }
  ],
  ProvisionedThroughput: {
    ReadCapacityUnits: 1,
    WriteCapacityUnits: 1
  },
  TableName: 'CUSTOMER_LIST',
  StreamSpecification: {
    StreamEnabled: false
  }
}

fixtures['kinesis'] = {
  ShardCount: 1,
  StreamName: 'test_aws_stream'
}

fixtures['s3'] = {
  Bucket: 'test-aws-bucket-9bd88aa3-6fc1-44bd-ae3a-ba25f49c3eef',
  Key: 'test.txt',
  Body: 'Hello World!'
}

fixtures['sqs'] = {
  QueueName: 'SQS_QUEUE_NAME',
  Attributes: {
    'DelaySeconds': '60',
    'MessageRetentionPeriod': '86400'
  }
}

fixtures['ddb_batch'] = {
  RequestItems: {
    [fixtures.ddb.TableName]: { // table name
      Keys: [
        {
          key: {
            N: "CUSTOMER_ID"
          }
        },
        {
          key: {
            S: "CUSTOMER_NAME"
          }
        }
      ],
      ConsistentRead: true
    }
  }
}

module.exports = fixtures
