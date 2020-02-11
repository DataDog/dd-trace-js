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
  }
}


module.exports = fixtures