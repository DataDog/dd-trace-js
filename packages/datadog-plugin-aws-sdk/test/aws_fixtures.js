const fixtures = {
  ddb: {
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
  },
  kinesis: {
    ShardCount: 1,
    StreamName: 'test_aws_stream'
  },
  s3: {
    Bucket: 'test-aws-bucket-9bd88aa3-6fc1-44bd-ae3a-ba25f49c3eef',
    Key: 'test.txt',
    Body: 'Hello World!'
  }
}


module.exports = fixtures