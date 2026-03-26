'use strict'

const { randomBytes } = require('crypto')
const { createSocket } = require('dgram')
const log = require('../../dd-trace/src/log')

const AMZN_TRACE_ID_ENV_VAR = '_X_AMZN_TRACE_ID'
const AWS_XRAY_DAEMON_ADDRESS_ENV_VAR = 'AWS_XRAY_DAEMON_ADDRESS'
const DD_TRACE_JAVA_TRACE_ID_PADDING = '00000000'
const SUBSEGMENT_NAME = 'datadog-metadata'
const SUBSEGMENT_NAMESPACE = 'datadog'
const SUBSEGMENT_KEY = 'trace'
const BAGGAGE_SUBSEGMENT_KEY = 'root_span_metadata'
const LAMBDA_FUNCTION_TAGS_KEY = 'lambda_function_tags'

const SAMPLE_MODE = {
  USER_REJECT: -1,
  AUTO_REJECT: 0,
  AUTO_KEEP: 1,
  USER_KEEP: 2
}

function hexStrToDecimalStr (hexString) {
  return BigInt('0x' + hexString).toString(10)
}

function parseAWSTraceHeader (awsTraceHeader) {
  const parts = awsTraceHeader.split(';')
  const root = parts[0]
  const parent = parts[1]
  const _sampled = parts[2]
  if (parent === undefined || _sampled === undefined) return undefined

  const traceIdParts = root.split('=')
  const parentIdParts = parent.split('=')
  const sampledParts = _sampled.split('=')

  const traceId = traceIdParts[1]
  const parentId = parentIdParts[1]
  const sampled = sampledParts[1]

  if (traceId === undefined || parentId === undefined || sampled === undefined) return undefined

  return { traceId, parentId, sampled }
}

function convertToSampleMode (xraySampled) {
  return xraySampled === 1 ? SAMPLE_MODE.USER_KEEP : SAMPLE_MODE.USER_REJECT
}

function convertToParentId (xrayParentId) {
  if (xrayParentId.length !== 16) return undefined
  try {
    return BigInt('0x' + xrayParentId).toString(10)
  } catch (e) {
    log.debug('Failed to convert X-Ray parent ID: %s', xrayParentId)
    return undefined
  }
}

function convertToTraceId (xrayTraceId) {
  const parts = xrayTraceId.split('-')
  if (parts.length < 3) return undefined

  const lastPart = parts[2]
  if (lastPart.length !== 24) return undefined

  try {
    return (BigInt('0x' + lastPart) % BigInt('0x8000000000000000')).toString(10)
  } catch (e) {
    log.debug('Failed to convert X-Ray trace ID: %s', lastPart)
    return undefined
  }
}

function parseXrayTraceId (header) {
  if (!header) {
    header = process.env[AMZN_TRACE_ID_ENV_VAR]
  }
  if (!header) return undefined
  return parseAWSTraceHeader(header)
}

function extractXrayContext () {
  const header = process.env[AMZN_TRACE_ID_ENV_VAR]
  if (header === undefined) {
    log.debug('Could not read X-Ray trace header from env')
    return null
  }

  log.debug('Reading X-Ray trace context from env var %s', header)
  const parsed = parseAWSTraceHeader(header)
  if (parsed === undefined) {
    log.debug('Could not parse X-Ray trace header from env')
    return null
  }

  const parentId = convertToParentId(parsed.parentId)
  if (parentId === undefined) {
    log.debug('Could not parse X-Ray parent ID')
    return null
  }

  const traceId = convertToTraceId(parsed.traceId)
  if (traceId === undefined) {
    log.debug('Could not parse X-Ray trace ID')
    return null
  }

  const sampleMode = convertToSampleMode(parseInt(parsed.sampled, 10))

  return {
    traceId,
    parentId,
    sampleMode,
    source: 'xray'
  }
}

function extractDDContextFromAWSTraceHeader (amznTraceId) {
  const awsContext = parseAWSTraceHeader(amznTraceId)
  if (awsContext === undefined) return null

  const traceIdParts = awsContext.traceId.split('-')
  if (traceIdParts && traceIdParts.length > 2 && traceIdParts[2].startsWith(DD_TRACE_JAVA_TRACE_ID_PADDING)) {
    return {
      traceId: hexStrToDecimalStr(traceIdParts[2].substring(8)),
      parentId: hexStrToDecimalStr(awsContext.parentId),
      sampleMode: parseInt(awsContext.sampled, 10),
      source: 'event'
    }
  }
  return null
}

function generateSubsegment (key, metadata) {
  const header = process.env[AMZN_TRACE_ID_ENV_VAR]
  if (header === undefined) {
    log.debug('Could not read X-Ray trace header from env')
    return undefined
  }

  const context = parseAWSTraceHeader(header)
  if (context === undefined) return undefined

  const sampled = convertToSampleMode(parseInt(context.sampled, 10))
  if (sampled === SAMPLE_MODE.USER_REJECT || sampled === SAMPLE_MODE.AUTO_REJECT) {
    log.debug('Discarding X-Ray metadata subsegment due to sampling')
    return undefined
  }

  const milliseconds = Date.now() * 0.001

  return JSON.stringify({
    id: randomBytes(8).toString('hex'),
    trace_id: context.traceId,
    parent_id: context.parentId,
    name: SUBSEGMENT_NAME,
    start_time: milliseconds,
    end_time: milliseconds,
    type: 'subsegment',
    metadata: {
      [SUBSEGMENT_NAMESPACE]: {
        [key]: metadata
      }
    }
  })
}

function sendSegmentToXray (segment) {
  const daemon = process.env[AWS_XRAY_DAEMON_ADDRESS_ENV_VAR]
  if (daemon === undefined) {
    log.debug('X-Ray daemon env var not set, not sending subsegment')
    return
  }

  const parts = daemon.split(':')
  if (parts.length <= 1) {
    log.debug('X-Ray daemon env var has invalid format, not sending subsegment')
    return
  }

  const port = parseInt(parts[1], 10)
  const address = parts[0]
  const message = Buffer.from('{"format": "json", "version": 1}\n' + segment)
  let client
  try {
    client = createSocket('udp4')
    client.send(message, 0, message.length, port, address, function (error, bytes) {
      if (client) client.close()
      log.debug('X-Ray daemon received metadata payload')
    })
  } catch (error) {
    if (client) client.close()
    log.debug('Error occurred submitting to X-Ray daemon: %s', error.message)
  }
}

function sendXraySubsegment (traceContext, lambdaContext) {
  if (!traceContext) return

  const metadata = {
    'trace-id': traceContext.traceId,
    'parent-id': traceContext.parentId,
    'sampling-priority': traceContext.sampleMode
  }

  const subsegment = generateSubsegment(SUBSEGMENT_KEY, metadata)
  if (subsegment !== undefined) {
    sendSegmentToXray(subsegment)
  }
}

function addLambdaTriggerTags (triggerTags) {
  const subsegment = generateSubsegment(LAMBDA_FUNCTION_TAGS_KEY, triggerTags)
  if (subsegment !== undefined) {
    sendSegmentToXray(subsegment)
  }
}

function addStepFunctionContext (stepFunctionContext) {
  const subsegment = generateSubsegment(BAGGAGE_SUBSEGMENT_KEY, stepFunctionContext)
  if (subsegment !== undefined) {
    sendSegmentToXray(subsegment)
  }
}

function addMetadata (metadata) {
  const subsegment = generateSubsegment(SUBSEGMENT_KEY, metadata)
  if (subsegment !== undefined) {
    sendSegmentToXray(subsegment)
  }
}

module.exports = {
  AMZN_TRACE_ID_ENV_VAR,
  SAMPLE_MODE,
  extractXrayContext,
  extractDDContextFromAWSTraceHeader,
  sendXraySubsegment,
  parseXrayTraceId: parseAWSTraceHeader,
  addLambdaTriggerTags,
  addStepFunctionContext,
  addMetadata
}
