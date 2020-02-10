'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
// const { expectSomeSpan, withDefaults } = require('../../dd-trace/test/plugins/helpers')
const plugin = require('../src')
// const id = require('../../dd-trace/src/id')

wrapIt()

// The roundtrip to the pubsub emulator takes time. Sometimes a *long* time.
const TIMEOUT = 60000

describe('Plugin', () => {
  let tracer


  describe('aws-sdk', function () {
    before(() => {

    })
    after(() => {
      // delete process.env.PUBSUB_EMULATOR_HOST
    })

    afterEach(() => {
      agent.close()
      agent.wipe()
    })
    withVersions(plugin, 'aws-sdk', version => {
      let ep_dynamo
      let ddb      

      describe('without configuration', () => {
        beforeEach(() => {
          tracer = require('../../dd-trace')
          

          console.log('version is', version)
          const AWS = require(`../../../versions/aws-sdk@${version}`).get()
          
          AWS.config.update({region: 'REGION'});
          ep_dynamo = new AWS.Endpoint('http://localhost:4569');
          ddb = new AWS.DynamoDB({apiVersion: '2012-08-10', endpoint: ep_dynamo});
          return agent.load(plugin, 'aws-sdk')
        })
        describe('createTable', () => {
          it('should be instrumented', (done) => {

          
            agent
              .use(traces => {
                console.log('in here')
                expect(traces[0][0]).to.have.property('resource', 'request')
                expect(traces[0][0]).to.have.property('name', 'aws.request')
              })
              .then(done)
              .catch(done)


            var params = {
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
            };       

            ddb.createTable(params, function(err_create, data_create) {
              console.log('ok?')
              if (err_create) {
                console.log("Error creating", err_create);

              } else {
                console.log("Table Created", data_create);

                ddb.deleteTable({TableName: params.TableName}, function(err_data, data_delete) {
                  if (err_data) {
                    console.log("Error deleting", err_delete);
                  } else {
                    console.log('Table Deleled', data_delete)
                  }
                })
              }
            });
          })
        })
      })
    })
  })
})