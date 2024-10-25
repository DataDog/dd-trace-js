'use strict'

const ddb = {}

ddb.create = {
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
  TableName: 'CUSTOMER_LIST'
}

ddb.put = {
  TableName: 'CUSTOMER_LIST',
  Item: {
    CUSTOMER_ID: { N: '001' },
    CUSTOMER_NAME: { S: 'Richard Roe' }
  }
}

ddb.get = {
  TableName: 'CUSTOMER_LIST',
  Key: {
    CUSTOMER_ID: { N: '001' },
    CUSTOMER_NAME: { S: 'Richard Roe' }
  }
}

ddb.batch = {
  RequestItems: {
    CUSTOMER_LIST: {
      Keys: [
        {
          CUSTOMER_ID: { N: '001' },
          CUSTOMER_NAME: { S: 'Richard Roe' }
        }
      ],
      ConsistentRead: true
    }
  }
}

module.exports = ddb
