'use strict'

const serialize = value => Buffer.from(JSON.stringify(value || ''))
const deserialize = buffer => JSON.parse(buffer.toString())

module.exports = grpc => {
  class TestService extends grpc.Client {
    getUnary (argument, ...more) {
      return this.makeUnaryRequest(
        '/test.TestService/getUnary',
        serialize,
        deserialize,
        argument,
        ...more
      )
    }

    getBidi (argument, ...more) {
      return this.makeBidiStreamRequest(
        '/test.TestService/getBidi',
        serialize,
        deserialize,
        argument,
        ...more
      )
    }

    getClientStream (argument, ...more) {
      return this.makeClientStreamRequest(
        '/test.TestService/getClientStream',
        serialize,
        deserialize,
        argument,
        ...more
      )
    }

    getServerStream (argument, ...more) {
      return this.makeServerStreamRequest(
        '/test.TestService/getServerStream',
        serialize,
        deserialize,
        argument,
        ...more
      )
    }
  }

  TestService.service = {
    getUnary: {
      path: '/test.TestService/getUnary',
      requestStream: false,
      responseStream: false,
      requestSerialize: serialize,
      responseSerialize: serialize,
      requestDeserialize: deserialize,
      responseDeserialize: deserialize
    },

    getBidi: {
      path: '/test.TestService/getBidi',
      requestStream: true,
      responseStream: true,
      requestSerialize: serialize,
      responseSerialize: serialize,
      requestDeserialize: deserialize,
      responseDeserialize: deserialize
    },

    getClientStream: {
      path: '/test.TestService/getClientStream',
      requestStream: true,
      responseStream: false,
      requestSerialize: serialize,
      responseSerialize: serialize,
      requestDeserialize: deserialize,
      responseDeserialize: deserialize
    },

    getServerStream: {
      path: '/test.TestService/getServerStream',
      requestStream: false,
      responseStream: true,
      requestSerialize: serialize,
      responseSerialize: serialize,
      requestDeserialize: deserialize,
      responseDeserialize: deserialize
    }
  }

  return TestService
}
