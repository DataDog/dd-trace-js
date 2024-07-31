'use strict'

const ChildProcessPlugin = require('../src')
const agent = require('../../dd-trace/test/plugins/agent')

describe('azure-functions', () => {
  before(() => {
    azure_func = require(`../../../versions/@azure/functions`).get()
    return agent.load('azure-funtions')
    // import azure 
    // app = 
  })

  after(() => {
    return agent.close({ ritmReset: false })
  })

  it('should do automatic instrumentation', done => {
    app = azure_func.app()
    app.get("")
    app.getResponse
    
    agent
      .use(traces => {
        const span = traces[0][0]
        const resource = `insert test.${collectionName}`

        expect(span).to.have.property('name', expectedSchema.outbound.opName)
        expect(span).to.have.property('service', expectedSchema.outbound.serviceName)
        expect(span).to.have.property('resource', resource)
        expect(span).to.have.property('type', 'mongodb')
        expect(span.meta).to.have.property('span.kind', 'client')
        expect(span.meta).to.have.property('db.name', `test.${collectionName}`)
        expect(span.meta).to.have.property('out.host', '127.0.0.1')
        expect(span.meta).to.have.property('component', 'mongodb')
      })
      .then(done)
      .catch(done)

    // collection.insertOne({ a: 1 }, {}, () => {}) // invocation?

  })
});