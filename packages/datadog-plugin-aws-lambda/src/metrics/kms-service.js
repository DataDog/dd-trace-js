'use strict'

const { getEnvironmentVariable } = require('../../../dd-trace/src/config/helper')
const { AWS_REGION, FIPS_MODE_ENABLED } = require('../fips')

class KMSService {
  #encryptionContext

  constructor () {
    this.#encryptionContext = {
      LambdaFunctionName: getEnvironmentVariable('AWS_LAMBDA_FUNCTION_NAME') ?? '',
    }
  }

  /** @param {string} ciphertext */
  async decrypt (ciphertext) {
    const buffer = Buffer.from(ciphertext, 'base64')
    const params = FIPS_MODE_ENABLED ? { endpoint: `https://kms-fips.${AWS_REGION}.amazonaws.com` } : {}
    let KMS
    // Runtime/app-provided SDKs stay optional for bundlers and non-Lambda tracer consumers.
    try {
      // eslint-disable-next-line n/no-missing-require -- Optional, provided by the Lambda runtime/application.
      KMS = require('aws-sdk/clients/kms')
    } catch (error) {
      if (error.code === 'MODULE_NOT_FOUND') return this.decryptV3(buffer, params)
    }
    try {
      const client = new KMS(params)
      let result
      try {
        result = await client.decrypt({ CiphertextBlob: buffer }).promise()
      } catch {
        result = await client.decrypt({ CiphertextBlob: buffer, EncryptionContext: this.#encryptionContext }).promise()
      }
      if (result.Plaintext === undefined) throw new Error("Couldn't decrypt ciphertext")
      return result.Plaintext.toString('ascii')
    } catch {
      throw new Error("Couldn't decrypt ciphertext")
    }
  }

  /**
   * @param {Buffer} buffer
   * @param {{ endpoint?: string }} params
   */
  async decryptV3 (buffer, params) {
    let KMSClient, DecryptCommand
    try {
      // eslint-disable-next-line n/no-missing-require -- Optional, provided by the Lambda runtime/application.
      ({ KMSClient, DecryptCommand } = require('@aws-sdk/client-kms'))
    } catch {
      throw new Error("Can't load AWS SDK v2 or v3 to decrypt KMS key, custom metrics may not be sent")
    }
    const client = new KMSClient(params)
    let result
    try {
      result = await client.send(new DecryptCommand({ CiphertextBlob: buffer }))
    } catch {
      result = await client.send(new DecryptCommand({
        CiphertextBlob: buffer, EncryptionContext: this.#encryptionContext,
      }))
    }
    return Buffer.from(result.Plaintext).toString('ascii')
  }
}

module.exports = { KMSService }
