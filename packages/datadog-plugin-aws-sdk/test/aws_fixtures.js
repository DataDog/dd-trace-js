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

fixtures['ddb_batch'] = {
  RequestItems: {
    [fixtures.ddb.TableName]: { // table name
      Keys: [
        {
          key: {
            N: 'CUSTOMER_ID'
          }
        },
        {
          key: {
            S: 'CUSTOMER_NAME'
          }
        }
      ],
      ConsistentRead: true
    }
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

fixtures['sns'] = {
  Name: 'example_aws_topic'
}

fixtures['sns_publish'] = {
  Message: 'STRING_VALUE', /* required */
  MessageAttributes: {
    '<String>': {
      DataType: 'STRING_VALUE', /* required */
      BinaryValue: Buffer.from('example string value') || 'STRING_VALUE', // Strings get Base-64 encoded
      StringValue: 'STRING_VALUE'
    }
  },
  MessageStructure: 'STRING_VALUE',
  PhoneNumber: 'STRING_VALUE',
  Subject: 'STRING_VALUE',
  TargetArn: 'STRING_VALUE',
  TopicArn: 'example_aws_topic'
}

module.exports = fixtures
