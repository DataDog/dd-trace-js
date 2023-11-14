require('./init')
const Aerospike = require('aerospike')

const config = {
  hosts: '127.0.0.1:3000'
  // user: 'test',
  // password: 'test'
}

const namespace = 'test'
const set = 'demo'
// test
const client = Aerospike.client(config)

client.connect(() => {
  client.put('', { i: 123 }, (err) => {
    error = err
    console.log(77, err)
  })
})

Aerospike.connect((error, client) => {
  if (error) throw error
  const index = {
    ns: namespace,
    set: set,
    bin: 'tags',
    index: 'tags_idx',
    type: Aerospike.indexType.LIST,
    datatype: Aerospike.indexDataType.STRING
  }
  client.createIndex(index, (error, job) => {
    if (error) throw error
    job.waitUntilDone((error) => {
      if (error) throw error

      const exp = Aerospike.exp
      const query = client.query('test', 'demo')
      const queryPolicy = { filterExpression: exp.keyExist('uniqueExpKey') }
      query.select('id', 'tags')
      query.where(Aerospike.filter.contains('tags', 'green', Aerospike.indexType.LIST))
      const stream = query.foreach(queryPolicy)
      stream.on('error', (error) => {
        console.error(error)
        throw error
      })
      stream.on('data', (record) => {
        console.info(record)
      })
      stream.on('end', () => {
        client.close()
      })
    })
  })
})

// Aerospike.connect(config)
//   .then(client => {
//     const bins = {
//       i: 123
//     }
//     const meta = { ttl: 10000 }
//     const policy = new Aerospike.WritePolicy({
//       exists: Aerospike.policy.exists.CREATE_OR_REPLACE,
//       socketTimeout: 0,
//       totalTimeout: 0
//     })

//     storage.run('test', () => {
//       // console.log('inside storage run', storage.getStore(), id.executionAsyncId())
//       client.put(key, bins, meta, policy, (error) => {
//         // console.log('inside client put', storage.getStore(), id.executionAsyncId())
//         if (error) {
//           console.error('Error in client.put:', error)
//           return
//         }

//         // console.log('Put operation successful.')

//         const ops = [
//           Aerospike.operations.incr('i', 1),
//           Aerospike.operations.read('i')
//         ]

//         client.operate(key, ops, (operateError, result) => {
//           if (operateError) {
//             console.error('Error in client.operate:', operateError)
//             return
//           }

//           // console.log('Operate operation successful. Result:', result.bins)

//           client.get(key, (getError, record) => {
//             if (getError) {
//               console.error('Error in client.get:', getError)
//               return
//             }

//             // console.log('Get operation successful. Record:', record.bins)

//             // Close the client
//             client.close((closeError) => {
//               if (closeError) {
//                 console.error('Error in client.close:', closeError)
//               } else {
//                 // console.log('Client closed.')
//               }
//             })
//           })
//         })
//       })
//     })

// return client.put(key, bins, meta, policy)
//   .then(() => {
//     const ops = [
//       Aerospike.operations.incr('i', 1),
//       Aerospike.operations.read('i')
//     ]

//     return client.operate(key, ops)
//   })
//   .then(result => {
//     console.log(result.bins)

//     return client.get(key)
//   })
//   .then(record => {
//     console.log(record.bins)
//   })
//   .then(() => client.close())
// })
// .catch(error => {
//   console.error('Error: %s [%i]', error.message, error.code)
//   if (error.client) {
//     error.client.close()
//   }
// })
