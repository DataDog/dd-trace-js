'use strict'

const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noCallThru()
const sinon = require('sinon')

const log = require('../../../dd-trace/src/log')

const ciphertext = 'BQICAHj0djbIQaGrIfSD2gstvRF3h8YGMeEvO5rRHNiuWwSeegEFl57KxNejRn'
const blob = Buffer.from(ciphertext, 'base64')
const context = { LambdaFunctionName: 'my-test-function' }
const plaintext = Buffer.from('myDecryptedKey')
const secretARN = 'arn:aws:secretsmanager:us-west-2:123456789012:secret:key'
const config = { apiKey: '', apiKeyKMS: '', apiKeySecretARN: '' }

describe('Lambda metrics key resolution source contracts', () => {
  afterEach(() => sinon.restore())

  function loadKMS (v2, v3, fips = false, region = 'us-east-1', functionName = 'my-test-function') {
    return proxyquire('../../src/metrics/kms-service', {
      'aws-sdk/clients/kms': v2,
      '@aws-sdk/client-kms': v3,
      '../fips': { FIPS_MODE_ENABLED: fips, AWS_REGION: region },
      '../../../dd-trace/src/config/helper': { getEnvironmentVariable: () => functionName },
    }).KMSService
  }

  for (const sdk of ['v2', 'v3']) {
    for (const encryptedWithContext of [false, true]) {
      it(`decrypts ${sdk} keys ${encryptedWithContext ? 'with' : 'without'} encryption context`, async () => {
        const decrypt = sinon.stub()
        if (encryptedWithContext) decrypt.onFirstCall().rejects(new Error('context required'))
        decrypt.resolves({ Plaintext: plaintext })
        const construct = sinon.spy()
        class V2 {
          constructor (options) { construct(options) }
          decrypt (input) { return { promise: () => decrypt(input) } }
        }
        class V3 {
          constructor (options) { construct(options) }
          send (command) { return decrypt(command.input) }
        }
        class Command {
          constructor (input) { this.input = input }
        }
        const KMSService = loadKMS(sdk === 'v2' ? V2 : null, { KMSClient: V3, DecryptCommand: Command })
        assert.strictEqual(await new KMSService().decrypt(ciphertext), 'myDecryptedKey')
        sinon.assert.calledOnceWithExactly(construct, {})
        assert.deepStrictEqual(decrypt.args, encryptedWithContext
          ? [[{ CiphertextBlob: blob }], [{ CiphertextBlob: blob, EncryptionContext: context }]]
          : [[{ CiphertextBlob: blob }]])
      })
    }

    for (const region of ['us-gov-west-1', 'us-east-1', '']) {
      it(`configures ${sdk} explicit FIPS endpoint in ${region || 'missing region'}`, async () => {
        const construct = sinon.spy()
        class V2 {
          constructor (options) { construct(options) }
          decrypt () { return { promise: async () => ({ Plaintext: plaintext }) } }
        }
        class V3 {
          constructor (options) { construct(options) }
          async send () { return { Plaintext: plaintext } }
        }
        const KMSService = loadKMS(sdk === 'v2' ? V2 : null,
          { KMSClient: V3, DecryptCommand: class {} }, true, region)
        assert.strictEqual(await new KMSService().decrypt(ciphertext), 'myDecryptedKey')
        sinon.assert.calledOnceWithExactly(construct, { endpoint: `https://kms-fips.${region}.amazonaws.com` })
      })
    }
  }

  it('normalizes v2 decryption failure after both context attempts', async () => {
    const decrypt = sinon.stub().rejects(new Error('denied'))
    const KMSService = loadKMS(class {
      decrypt (input) { return { promise: () => decrypt(input) } }
    }, null)
    await assert.rejects(new KMSService().decrypt(ciphertext), { message: "Couldn't decrypt ciphertext" })
    assert.strictEqual(decrypt.callCount, 2)
  })

  it('rejects missing v2 plaintext', async () => {
    const KMSService = loadKMS(class { decrypt () { return { promise: async () => ({}) } } }, null)
    await assert.rejects(new KMSService().decrypt(ciphertext), { message: "Couldn't decrypt ciphertext" })
  })

  it('normalizes a v2 constructor failure rather than falling back', async () => {
    const KMSService = loadKMS(class { constructor () { throw new Error('load failure') } }, null)
    await assert.rejects(new KMSService().decrypt(ciphertext), { message: "Couldn't decrypt ciphertext" })
  })

  it('reports missing optional SDKs without requiring them at module load', async () => {
    const KMSService = loadKMS(null, null)
    await assert.rejects(new KMSService().decrypt(ciphertext), {
      message: "Can't load AWS SDK v2 or v3 to decrypt KMS key, custom metrics may not be sent",
    })
  })

  it('retains the v3 second-attempt error', async () => {
    const failure = new Error('v3 denied')
    const send = sinon.stub().rejects(failure)
    const KMSService = loadKMS(null, {
      KMSClient: class { send (input) { return send(input) } }, DecryptCommand: class {},
    })
    await assert.rejects(new KMSService().decrypt(ciphertext), error => error === failure)
    assert.strictEqual(send.callCount, 2)
  })

  it('defaults missing function identity to an empty encryption context name', async () => {
    const decrypt = sinon.stub().onFirstCall().rejects().resolves({ Plaintext: plaintext })
    // No environment identity is an empty string in the source.
    const EmptyKMS = proxyquire('../../src/metrics/kms-service', {
      'aws-sdk/clients/kms': class { decrypt (input) { return { promise: () => decrypt(input) } } },
      '../fips': { FIPS_MODE_ENABLED: false },
      '../../../dd-trace/src/config/helper': { getEnvironmentVariable: () => undefined },
    }).KMSService
    await new EmptyKMS().decrypt(ciphertext)
    assert.deepStrictEqual(decrypt.secondCall.args[0].EncryptionContext, { LambdaFunctionName: '' })
  })

  function loadKeyResolver (decrypt, getSecretValue, fips = false, SecretsManager) {
    const construct = sinon.spy()
    const getAPIKey = proxyquire('../../src/metrics/api-key', {
      './kms-service': { KMSService: class { decrypt (key) { return decrypt(key) } } },
      '../fips': { FIPS_MODE_ENABLED: fips },
      '@aws-sdk/client-secrets-manager': {
        SecretsManager: SecretsManager ?? class {
          constructor (options) { construct(options) }
          getSecretValue (input) { return getSecretValue(input) }
        },
      },
    }).getAPIKey
    return { getAPIKey, construct }
  }

  for (const apiKey of ['plaintext', null, undefined]) {
    it(`returns explicit plaintext ${apiKey} without loading either remote key`, async () => {
      const decrypt = sinon.stub()
      const secret = sinon.stub()
      const { getAPIKey, construct } = loadKeyResolver(decrypt, secret)
      assert.strictEqual(await getAPIKey({ apiKey, apiKeyKMS: 'cipher', apiKeySecretARN: secretARN }), apiKey)
      sinon.assert.notCalled(decrypt)
      sinon.assert.notCalled(secret)
      sinon.assert.notCalled(construct)
    })
  }

  for (const key of ['decrypted', '']) {
    it(`uses KMS success ${JSON.stringify(key)} without secret fallback`, async () => {
      const decrypt = sinon.stub().resolves(key)
      const secret = sinon.stub()
      const { getAPIKey } = loadKeyResolver(decrypt, secret)
      assert.strictEqual(await getAPIKey({ ...config, apiKeyKMS: 'cipher', apiKeySecretARN: secretARN }), key)
      sinon.assert.calledOnceWithExactly(decrypt, 'cipher')
      sinon.assert.notCalled(secret)
    })
  }

  for (const fips of [false, true]) {
    it(`falls back from KMS failure to the ARN's Secrets Manager region, FIPS=${fips}`, async () => {
      const decrypt = sinon.stub().rejects(new Error('kms unavailable'))
      const secret = sinon.stub().resolves({ SecretString: 'secret' })
      const { getAPIKey, construct } = loadKeyResolver(decrypt, secret, fips)
      assert.strictEqual(await getAPIKey({ ...config, apiKeyKMS: 'cipher', apiKeySecretARN: secretARN }), 'secret')
      sinon.assert.calledOnceWithExactly(construct, { useFipsEndpoint: fips, region: 'us-west-2' })
      sinon.assert.calledOnceWithExactly(secret, { SecretId: secretARN })
    })
  }

  for (const response of [undefined, {}, { SecretBinary: Buffer.from('binary') }, { SecretString: '' }]) {
    it(`returns an empty key without a SecretString: ${JSON.stringify(response)}`, async () => {
      const { getAPIKey } = loadKeyResolver(sinon.stub(), sinon.stub().resolves(response))
      assert.strictEqual(await getAPIKey({ ...config, apiKeySecretARN: secretARN }), '')
    })
  }

  it('logs remote failures and returns an empty key', async () => {
    const error = sinon.stub(log, 'error')
    const { getAPIKey } = loadKeyResolver(sinon.stub().rejects(), sinon.stub().rejects())
    assert.strictEqual(await getAPIKey({ ...config, apiKeyKMS: 'cipher', apiKeySecretARN: secretARN }), '')
    assert.strictEqual(error.callCount, 2)
  })

  it('contains a missing optional Secrets Manager SDK', async () => {
    const { getAPIKey } = proxyquire('../../src/metrics/api-key', {
      './kms-service': { KMSService: class {} },
      '../fips': { FIPS_MODE_ENABLED: false },
      '@aws-sdk/client-secrets-manager': null,
    })
    assert.strictEqual(await getAPIKey({ ...config, apiKeySecretARN: secretARN }), '')
  })

  it('does not fetch or cache credentials while loading the helper', async () => {
    const decrypt = sinon.stub().resolves('key')
    const secret = sinon.stub()
    const { getAPIKey, construct } = loadKeyResolver(decrypt, secret)
    sinon.assert.notCalled(decrypt)
    sinon.assert.notCalled(construct)
    assert.strictEqual(await getAPIKey(config), '')
    await getAPIKey({ ...config, apiKeyKMS: 'cipher' })
    await getAPIKey({ ...config, apiKeyKMS: 'cipher' })
    assert.strictEqual(decrypt.callCount, 2)
  })
})
