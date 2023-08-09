import 'dd-trace/init.js'
import AWS from 'aws-sdk'

const s3 = new AWS.S3({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1', s3ForcePathStyle: true })

s3.listBuckets({}, e => e)
