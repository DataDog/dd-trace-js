'use strict'

const log = require('../../../dd-trace/src/log')
const { FIPS_MODE_ENABLED } = require('../fips')
const { KMSService } = require('./kms-service')

/**
 * Resolve on first invocation, not during proactive initialization: temporary AWS credentials may expire meanwhile.
 * The lifecycle owner will cache this promise; this helper does not create an independent cache or metrics queue.
 * @param {{ apiKey: string, apiKeyKMS: string, apiKeySecretARN: string }} config Normalized shim metrics options.
 */
async function getAPIKey (config) {
  if (config.apiKey !== '') return config.apiKey
  if (config.apiKeyKMS !== '') {
    try {
      return await new KMSService().decrypt(config.apiKeyKMS)
    } catch (error) {
      log.error("couldn't decrypt kms api key: %s", error)
    }
  }
  if (config.apiKeySecretARN !== '') {
    try {
      // The Lambda runtime supplies this SDK; do not make it a tracer dependency.
      // eslint-disable-next-line n/no-missing-require -- Optional, provided by the Lambda runtime/application.
      const { SecretsManager } = require('@aws-sdk/client-secrets-manager')
      const client = new SecretsManager({
        useFipsEndpoint: FIPS_MODE_ENABLED,
        region: config.apiKeySecretARN.split(':')[3],
      })
      const secret = await client.getSecretValue({ SecretId: config.apiKeySecretARN })
      return secret?.SecretString ?? ''
    } catch (error) {
      log.error("couldn't get secrets manager api key: %s", error)
    }
  }
  return ''
}

module.exports = { getAPIKey }
