import 'dd-trace/init.js'
import couchbase from 'couchbase'

async function connectToCouchbase () {
  return new Promise((resolve, reject) => {
    const cluster = new couchbase.Cluster('couchbase://localhost')
    cluster.authenticate('Administrator', 'password')
    const bucket = cluster.bucket('datadog-test')

    bucket.on('connect', () => {
      resolve({ cluster, bucket })
    })

    bucket.on('error', (error) => {
      reject(error)
    })
  })
}

async function runIntegrationTest () {
  try {
    const { cluster, bucket } = await connectToCouchbase()

    const query = 'SELECT 1 + 1 AS solution'
    const n1qlQuery = couchbase.N1qlQuery.fromString(query)

    // Run a N1QL query
    bucket.query(n1qlQuery, (err) => {
      if (err) {
        console.error('Error running N1QL query:', err.message)
      }
    })

    // Perform a normal cluster query operation with a callback
    cluster.query(query, (err) => {
      if (err) {
        console.error('Error running cluster query:', err.message)
      }
    })

    const documentId = 'foo'
    bucket.get(documentId, (err) => {
      if (err) {
        console.error('Error fetching document:', err.message)
      }
    })

    await new Promise((resolve) => {
      cluster.once('error', (error) => {
        console.error('Error closing cluster:', error.message)
      })
      cluster.once('close', () => {
        console.log('Cluster closed gracefully.')
        resolve()
      })
      cluster.close()
    })
  } catch (error) {
    console.error('Error connecting to Couchbase:', error.message)
  }
}

runIntegrationTest()
