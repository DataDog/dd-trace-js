/* eslint-disable max-len */
'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { setup } = require('./spec_helpers')

const s3Params = {
  Bucket: "examplebucket", 
  CreateBucketConfiguration: {
   LocationConstraint: "sa-east-1"
  }
};

describe('S3', () => {
  describe('aws-sdk (s3)', function () {
    setup()

    withVersions('aws-sdk', ['aws-sdk', '@aws-sdk/smithy-client'], (version, moduleName) => {
      if(version<'3.0.0'){
        return
      }
      let AWS
      let s3
      let tracer

      const s3ClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-s3' : 'aws-sdk'
      describe('without configuration', () => {
        before(() => {
          tracer = require('../../dd-trace')

          return agent.load('aws-sdk')
        })

        before(done => {
          
          AWS = require(`../../../versions/${s3ClientName}@${version}`).get()

          s3 = new AWS.S3({
            endpoint: 'http://127.0.0.1:4566',
            region: 'sa-east-1',
            s3ForcePathStyle: true
          })
          done()

        })

        after(done => {
          s3.deleteBucket({ Bucket: "examplebucket" }, done)
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })


        /* it.only('should run the getObject in the context of its span', (done) => {
          
          console.log("foobar before createBucket")
          s3.createBucket(s3Params, (err) => {
            if (err) return done(err)
            done()
          })
          debugger;    
          const span = tracer.scope().active()

          console.log("span: "+ span)
            //expect(span.context()._tags['aws.operation']).to.equal('getObject')
            //expect(span.context()._tags['bucketname']).to.equal('getObject')
        }) */
      
        it.only('should run the getObject in the context of its span', async () => {
          this.timeout(10000);
          debugger
          console.log("foobar before createBucket");
        
          // Convert the createBucket function to a Promise-based function
          const createBucketPromise = (params) => {
            return new Promise((resolve, reject) => {
              console.log("Creating bucket")
              s3.createBucket(params, (err, data) => {
                if (err) reject(err);
                else resolve(data);
              });
            });
          };
        
          try {
            // Await the createBucket function
            await createBucketPromise(s3Params);
        
            debugger;
            console.log("grabbing span")
            const span = tracer.scope().active();
        
            console.log("span: " + span);
            //expect(span.context()._tags['aws.operation']).to.equal('getObject');
            //expect(span.context()._tags['bucketname']).to.equal('getObject');
          } catch (err) {
            // Handle any errors that occur during createBucket
            console.error(err);
          }
        });
        
      })
    })
  })
})
