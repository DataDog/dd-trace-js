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

fixtures['ddb_put_item'] = {
  TableName: 'CUSTOMER_LIST',
  Item: {
    'CUSTOMER_ID': { N: '001' },
    'CUSTOMER_NAME': { S: 'Richard Roe' }
  }
}

fixtures['ddb_get_item'] = {
  TableName: 'CUSTOMER_LIST',
  Key: {
    'CUSTOMER_ID': { N: '001' },
    'CUSTOMER_NAME': { S: 'Richard Roe' }
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

fixtures['kinesis_describe'] = {
  StreamName: 'test_aws_stream'
}

fixtures['s3_put'] = {
  Bucket: 'test-aws-bucket-9bd88aa3-6fc1-44bd-ae3a-ba25f49c3eef',
  Key: 'test.txt',
  Body: 'Hello World!'
}

fixtures['s3_create'] = {
  Bucket: 'test-aws-bucket-9bd88aa3-6fc1-44bd-ae3a-ba25f49c3eef'
}

fixtures['sqs_create'] = {
  QueueName: 'SQS_QUEUE_NAME',
  Attributes: {
    'DelaySeconds': '60',
    'MessageRetentionPeriod': '86400'
  }
}

fixtures['sqs_get'] = {
  QueueUrl: undefined
}

fixtures['sns_create'] = {
  Name: 'example_aws_topic'
}

fixtures['sns_get'] = {
  TopicArn: undefined
}

fixtures['cw_logs_create'] = {
  logGroupName: 'example_cw_log_group'
}

fixtures['redshift_create_params'] = {
  ClusterIdentifier: 'example_redshift_cluster',
  MasterUserPassword: 'example_user_password',
  MasterUsername: 'example_username',
  NodeType: 'ds2.large'
}

fixtures['redshift_get_params'] = {
  ClusterIdentifier: 'example_redshift_cluster'
}

module.exports = fixtures
