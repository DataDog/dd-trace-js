'use strict'
const AWS = require('aws-sdk')

// Configure AWS credentials and region
AWS.config.update({ region: 'us-east-1' })

const options = {
  service: 'test-service',
  sampleRate: 1.0
}

if (process.env.AGENT_PORT) {
  options.port = process.env.AGENT_PORT
}

if (process.env.lOG_INJECTION) {
  options.logInjection = process.env.lOG_INJECTION
}

const tracer = require('dd-trace')
tracer.init(options)

const winston = require('winston')
const express = require('express')

const app = express()

// Create winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console({ silent: true })
  ]
})

// Create an SQS service object
const sqs = new AWS.SQS({ apiVersion: '2012-11-05' })

// Define message parameters
const params = {
  MessageBody: 'This is a test message from a standalone Node.js application.',
  QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/MyTestQueue' // Replace with your SQS queue URL
}

// Send the message
sqs.sendMessage(params, (err, data) => {
  if (err) {
    logger.error('Error sending message:', err)
  } else {
    logger.info('Message sent successfully. Message ID:', data.MessageId)
  }
})

const server = app.listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
