'use strict'

async function loadMessage (protobuf, messageTypeName) {
  if (messageTypeName === 'OtherMessage') {
    const root = await protobuf.load('packages/datadog-plugin-protobufjs/test/schemas/other_message.proto')
    const OtherMessage = root.lookupType('OtherMessage')
    const message = OtherMessage.create({
      name: ['Alice'],
      age: 30
    })
    return {
      OtherMessage: {
        type: OtherMessage,
        instance: message
      }
    }
  } else if (messageTypeName === 'MyMessage') {
    const messageProto = await protobuf.load('packages/datadog-plugin-protobufjs/test/schemas/message.proto')
    const otherMessageProto = await protobuf.load(
      'packages/datadog-plugin-protobufjs/test/schemas/other_message.proto'
    )
    const Status = messageProto.lookupEnum('Status')
    const MyMessage = messageProto.lookupType('MyMessage')
    const OtherMessage = otherMessageProto.lookupType('OtherMessage')
    const message = MyMessage.create({
      id: '123',
      value: 'example_value',
      status: Status.values.ACTIVE,
      otherMessage: [
        OtherMessage.create({ name: ['Alice'], age: 30 }),
        OtherMessage.create({ name: ['Bob'], age: 25 })
      ]
    })
    return {
      OtherMessage: {
        type: OtherMessage,
        instance: null
      },
      MyMessage: {
        type: MyMessage,
        instance: message
      }
    }
  } else if (messageTypeName === 'MainMessage') {
    const root = await protobuf.load('packages/datadog-plugin-protobufjs/test/schemas/all_types.proto')

    const Status = root.lookupEnum('example.Status')
    const Scalars = root.lookupType('example.Scalars')
    const NestedMessage = root.lookupType('example.NestedMessage')
    const ComplexMessage = root.lookupType('example.ComplexMessage')
    const MainMessage = root.lookupType('example.MainMessage')

    // Create instances of the messages
    const scalarsInstance = Scalars.create({
      int32Field: 42,
      int64Field: 123456789012345,
      uint32Field: 123,
      uint64Field: 123456789012345,
      sint32Field: -42,
      sint64Field: -123456789012345,
      fixed32Field: 42,
      fixed64Field: 123456789012345,
      sfixed32Field: -42,
      sfixed64Field: -123456789012345,
      floatField: 3.14,
      doubleField: 2.718281828459,
      boolField: true,
      stringField: 'Hello, world!',
      bytesField: Buffer.from('bytes data')
    })

    const nestedMessageInstance = NestedMessage.create({
      id: 'nested_id_123',
      scalars: scalarsInstance
    })

    const complexMessageInstance = ComplexMessage.create({
      repeatedField: ['item1', 'item2', 'item3'],
      mapField: {
        key1: scalarsInstance,
        key2: Scalars.create({
          int32Field: 24,
          stringField: 'Another string'
        })
      }
    })

    const mainMessageInstance = MainMessage.create({
      status: Status.values.ACTIVE,
      scalars: scalarsInstance,
      nested: nestedMessageInstance,
      complex: complexMessageInstance
    })

    return {
      MainMessage: {
        type: MainMessage,
        instance: mainMessageInstance
      }
    }
  }
}

module.exports = {
  loadMessage
}
