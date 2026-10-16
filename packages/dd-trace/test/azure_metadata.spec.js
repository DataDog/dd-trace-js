'use strict'

const assert = require('node:assert/strict')
const os = require('node:os')

const { describe, it, afterEach } = require('mocha')
const proxyquire = require('proxyquire')

require('./setup/core')
const {
  getACATagsFromMetadata,
  getAzureAppMetadata,
  getAzureContainerAppMetadata,
  getAzureTagsFromMetadata,
  getAzureFunctionMetadata,
} = proxyquire('../src/azure_metadata', {
  './config': () => {
    const loadConfig = proxyquire.noPreserveCache()
    const createConfig = loadConfig('../src/config', {})
    return createConfig()
  },
})

describe('Azure metadata', () => {
  const AZURE_ENV_KEYS = [
    'COMPUTERNAME',
    'CONTAINER_APP_ENV_DNS_SUFFIX',
    'CONTAINER_APP_NAME',
    'CONTAINER_APP_REPLICA_NAME',
    'CONTAINER_APP_REVISION',
    'DD_AZURE_RESOURCE_GROUP',
    'DD_AZURE_SUBSCRIPTION_ID',
    'FUNCTIONS_EXTENSION_VERSION',
    'FUNCTIONS_WORKER_RUNTIME',
    'FUNCTIONS_WORKER_RUNTIME_VERSION',
    'WEBSITE_INSTANCE_ID',
    'WEBSITE_OWNER_NAME',
    'WEBSITE_OS',
    'WEBSITE_RESOURCE_GROUP',
    'WEBSITE_SITE_NAME',
    'WEBSITE_SKU',
  ]

  const initialAzureEnv = Object.fromEntries(AZURE_ENV_KEYS.map(key => [key, process.env[key]]))

  afterEach(() => {
    for (const key of AZURE_ENV_KEYS) {
      const value = initialAzureEnv[key]
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  describe('for apps is', () => {
    it('not provided without WEBSITE_SITE_NAME', () => {
      delete process.env.WEBSITE_SITE_NAME
      assert.strictEqual(getAzureAppMetadata(), undefined)
    })

    it('provided with WEBSITE_SITE_NAME', () => {
      delete process.env.COMPUTERNAME // actually defined on Windows
      process.env.WEBSITE_SITE_NAME = 'website_name'
      assert.deepStrictEqual(getAzureAppMetadata(), {
        operatingSystem: os.platform(), siteKind: 'app', siteName: 'website_name', siteType: 'app',
      })
    })
  })

  it('provided completely with minimum vars', () => {
    process.env.COMPUTERNAME = 'boaty_mcboatface'
    process.env.WEBSITE_SITE_NAME = 'website_name'
    process.env.WEBSITE_OWNER_NAME = 'subscription_id+resource_group-regionwebspace'
    process.env.WEBSITE_INSTANCE_ID = 'instance_id'
    const expected = {
      instanceID: 'instance_id',
      instanceName: 'boaty_mcboatface',
      operatingSystem: os.platform(),
      resourceGroup: 'resource_group',
      resourceID:
        '/subscriptions/subscription_id/resourcegroups/resource_group/providers/microsoft.web/sites/website_name',
      siteKind: 'app',
      siteName: 'website_name',
      siteType: 'app',
      subscriptionID: 'subscription_id',
    }
    assert.deepStrictEqual(getAzureAppMetadata(), expected)
  })

  it('provided completely with complete vars', () => {
    process.env.COMPUTERNAME = 'boaty_mcboatface'
    process.env.WEBSITE_SITE_NAME = 'website_name'
    process.env.WEBSITE_RESOURCE_GROUP = 'resource_group'
    process.env.WEBSITE_OWNER_NAME = 'subscription_id+foo-regionwebspace'
    process.env.WEBSITE_OS = 'windows'
    process.env.WEBSITE_INSTANCE_ID = 'instance_id'
    process.env.FUNCTIONS_EXTENSION_VERSION = '20'
    process.env.FUNCTIONS_WORKER_RUNTIME = 'node'
    process.env.FUNCTIONS_WORKER_RUNTIME_VERSION = '14'
    const expected = {
      functionRuntimeVersion: '20',
      instanceID: 'instance_id',
      instanceName: 'boaty_mcboatface',
      operatingSystem: 'windows',
      resourceGroup: 'resource_group',
      resourceID:
        '/subscriptions/subscription_id/resourcegroups/resource_group/providers/microsoft.web/sites/website_name',
      runtime: 'node',
      runtimeVersion: '14',
      siteKind: 'functionapp',
      siteName: 'website_name',
      siteType: 'function',
      subscriptionID: 'subscription_id',
    }
    assert.deepStrictEqual(getAzureAppMetadata(), expected)
  })

  it('tags are correctly generated from vars', () => {
    process.env.COMPUTERNAME = 'boaty_mcboatface'
    process.env.WEBSITE_SITE_NAME = 'website_name'
    process.env.WEBSITE_OWNER_NAME = 'subscription_id+resource_group-regionwebspace'
    process.env.WEBSITE_INSTANCE_ID = 'instance_id'
    const expected = {
      'aas.environment.instance_id': 'instance_id',
      'aas.environment.instance_name': 'boaty_mcboatface',
      'aas.environment.os': os.platform(),
      'aas.resource.group': 'resource_group',
      'aas.resource.id':
        '/subscriptions/subscription_id/resourcegroups/resource_group/providers/microsoft.web/sites/website_name',
      'aas.site.kind': 'app',
      'aas.site.name': 'website_name',
      'aas.site.type': 'app',
      'aas.subscription.id': 'subscription_id',
    }
    assert.deepStrictEqual(getAzureTagsFromMetadata(getAzureAppMetadata()), expected)
  })

  it('uses DD_AZURE_RESOURCE_GROUP for Flex Consumption Azure Functions', () => {
    process.env.COMPUTERNAME = 'flex_function'
    process.env.WEBSITE_SITE_NAME = 'flex_function_app'
    process.env.WEBSITE_OWNER_NAME = 'subscription_id+flex-regionwebspace'
    process.env.WEBSITE_INSTANCE_ID = 'instance_id'
    process.env.WEBSITE_SKU = 'FlexConsumption'
    process.env.FUNCTIONS_EXTENSION_VERSION = '4'
    process.env.FUNCTIONS_WORKER_RUNTIME = 'node'
    process.env.DD_AZURE_RESOURCE_GROUP = 'flex_resource_group'
    const expected = {
      functionRuntimeVersion: '4',
      instanceID: 'instance_id',
      instanceName: 'flex_function',
      operatingSystem: os.platform(),
      resourceGroup: 'flex_resource_group',
      resourceID:
        '/subscriptions/subscription_id/resourcegroups/flex_resource_group' +
        '/providers/microsoft.web/sites/flex_function_app',
      runtime: 'node',
      siteKind: 'functionapp',
      siteName: 'flex_function_app',
      siteType: 'function',
      subscriptionID: 'subscription_id',
    }
    assert.deepStrictEqual(getAzureFunctionMetadata(), expected)
  })

  it('uses WEBSITE_RESOURCE_GROUP for non-Flex Consumption plans', () => {
    process.env.WEBSITE_SITE_NAME = 'regular_function_app'
    process.env.WEBSITE_RESOURCE_GROUP = 'regular_resource_group'
    process.env.WEBSITE_OWNER_NAME = 'subscription_id+extracted_group-regionwebspace'
    process.env.WEBSITE_SKU = 'Consumption'
    process.env.FUNCTIONS_EXTENSION_VERSION = '4'
    process.env.FUNCTIONS_WORKER_RUNTIME = 'node'
    process.env.DD_AZURE_RESOURCE_GROUP = 'should_not_use_this'
    const metadata = getAzureFunctionMetadata()
    assert.strictEqual(metadata.resourceGroup, 'regular_resource_group')
  })

  describe('for container apps is', () => {
    it('not provided without CONTAINER_APP_NAME', () => {
      delete process.env.CONTAINER_APP_NAME
      assert.strictEqual(getAzureContainerAppMetadata(), undefined)
    })

    it('provided with CONTAINER_APP_NAME', () => {
      delete process.env.COMPUTERNAME // actually defined on Windows
      process.env.CONTAINER_APP_NAME = 'my-containerapp'
      assert.deepStrictEqual(getAzureContainerAppMetadata(), {
        appName: 'my-containerapp',
        appRegion: 'unknown',
        operatingSystem: os.platform(),
        siteKind: 'app',
        siteType: 'app',
      })
    })

    it('not provided for an App Service app', () => {
      delete process.env.CONTAINER_APP_NAME
      process.env.WEBSITE_SITE_NAME = 'website_name'
      assert.strictEqual(getAzureContainerAppMetadata(), undefined)
    })
  })

  describe('container app tags', () => {
    it('are empty without metadata', () => {
      assert.deepStrictEqual(getACATagsFromMetadata(undefined), {})
    })

    it('are generated from the container app vars', () => {
      process.env.CONTAINER_APP_NAME = 'my-containerapp'
      process.env.CONTAINER_APP_REVISION = 'my-containerapp--20mh1s9'
      process.env.CONTAINER_APP_REPLICA_NAME = 'my-containerapp--20mh1s9-86c8c4b497-zx9bq'
      process.env.CONTAINER_APP_ENV_DNS_SUFFIX = 'wonderfulmoss-f1e2d3c4.eastus.azurecontainerapps.io'
      assert.deepStrictEqual(getACATagsFromMetadata(getAzureContainerAppMetadata()), {
        'aca.app.name': 'my-containerapp',
        'aca.app.region': 'eastus',
        'aca.app.revision': 'my-containerapp--20mh1s9',
        'aca.replica.name': 'my-containerapp--20mh1s9-86c8c4b497-zx9bq',
      })
    })

    it('never derive the ACA identity from the App Service vars', () => {
      // A function hosted on container apps can carry the WEBSITE_* vars too, which would otherwise
      // build a `microsoft.web/sites` ID and publish it under the ACA key.
      process.env.CONTAINER_APP_NAME = 'my-containerapp'
      process.env.WEBSITE_SITE_NAME = 'my-func'
      process.env.WEBSITE_RESOURCE_GROUP = 'website_resource_group'
      process.env.WEBSITE_OWNER_NAME = 'subscription_id+resource_group-regionwebspace'
      const tags = getACATagsFromMetadata(getAzureContainerAppMetadata())
      assert.strictEqual(tags['aca.resource.id'], undefined)
      assert.strictEqual(tags['aca.subscription.id'], undefined)
      assert.strictEqual(tags['aca.resource.group'], undefined)
    })

    it('build the ACA resource ID from the DD_AZURE_* config', () => {
      process.env.CONTAINER_APP_NAME = 'My-ContainerApp'
      process.env.DD_AZURE_SUBSCRIPTION_ID = 'subscription_id'
      process.env.DD_AZURE_RESOURCE_GROUP = 'resource_group'
      const tags = getACATagsFromMetadata(getAzureContainerAppMetadata())
      assert.strictEqual(tags['aca.subscription.id'], 'subscription_id')
      assert.strictEqual(tags['aca.resource.group'], 'resource_group')
      assert.strictEqual(
        tags['aca.resource.id'],
        '/subscriptions/subscription_id/resourcegroups/resource_group' +
        '/providers/microsoft.app/containerapps/my-containerapp'
      )
    })

    it('omit the ACA resource ID when only one of the DD_AZURE_* values is set', () => {
      process.env.CONTAINER_APP_NAME = 'my-containerapp'
      process.env.DD_AZURE_SUBSCRIPTION_ID = 'subscription_id'
      const tags = getACATagsFromMetadata(getAzureContainerAppMetadata())
      assert.strictEqual(tags['aca.subscription.id'], 'subscription_id')
      assert.strictEqual(tags['aca.resource.id'], undefined)
    })

    it('omit the aas.environment.* tags outside Azure Functions', () => {
      process.env.CONTAINER_APP_NAME = 'my-containerapp'
      const tags = getACATagsFromMetadata(getAzureContainerAppMetadata())
      assert.deepStrictEqual(Object.keys(tags).filter(key => key.startsWith('aas.')), [])
    })

    it('include the Azure Functions runtime context for a function hosted on container apps', () => {
      delete process.env.COMPUTERNAME
      process.env.CONTAINER_APP_NAME = 'my-containerapp'
      process.env.CONTAINER_APP_ENV_DNS_SUFFIX = 'wonderfulmoss-f1e2d3c4.eastus.azurecontainerapps.io'
      process.env.FUNCTIONS_EXTENSION_VERSION = '~4'
      process.env.FUNCTIONS_WORKER_RUNTIME = 'node'
      process.env.FUNCTIONS_WORKER_RUNTIME_VERSION = '22'
      assert.deepStrictEqual(getACATagsFromMetadata(getAzureContainerAppMetadata()), {
        'aas.environment.function_runtime': '~4',
        'aas.environment.os': os.platform(),
        'aas.environment.runtime': 'node',
        'aas.environment.runtime_version': '22',
        'aca.app.name': 'my-containerapp',
        'aca.app.region': 'eastus',
      })
    })
  })

  describe('region extraction from CONTAINER_APP_ENV_DNS_SUFFIX', () => {
    /** @param {string} [dnsSuffix] */
    function regionFor (dnsSuffix) {
      process.env.CONTAINER_APP_NAME = 'my-containerapp'
      if (dnsSuffix === undefined) {
        delete process.env.CONTAINER_APP_ENV_DNS_SUFFIX
      } else {
        process.env.CONTAINER_APP_ENV_DNS_SUFFIX = dnsSuffix
      }
      return getAzureContainerAppMetadata().appRegion
    }

    it('reads the label before the two-label tail', () => {
      assert.strictEqual(regionFor('wonderfulmoss-f1e2d3c4.eastus.azurecontainerapps.io'), 'eastus')
    })

    it('ignores how many labels the default hostname spans', () => {
      assert.strictEqual(regionFor('test.bluebeach.eastus.azurecontainerapps.io'), 'eastus')
    })

    it('extracts from the shortest accepted form', () => {
      assert.strictEqual(regionFor('eastus.azurecontainerapps.io'), 'eastus')
    })

    it('does not depend on the top-level domain', () => {
      // Anchoring from the right keeps sovereign clouds working.
      assert.strictEqual(regionFor('eastus.azurecontainerapps.us'), 'eastus')
    })

    it('falls back to unknown with only two labels', () => {
      // First rejected length: one label short of the three the format requires.
      assert.strictEqual(regionFor('foo.bar'), 'unknown')
    })

    it('falls back to unknown when the region label is empty', () => {
      assert.strictEqual(regionFor('.azurecontainerapps.io'), 'unknown')
    })

    it('falls back to unknown when the suffix is empty', () => {
      assert.strictEqual(regionFor(''), 'unknown')
    })

    it('falls back to unknown when the suffix is unset', () => {
      assert.strictEqual(regionFor(undefined), 'unknown')
    })

    it('reads the third label from the right of a custom domain suffix', () => {
      // Matches the Agent, which also has no way to tell a custom suffix from the
      // platform one: cmd/serverless-init/cloudservice/containerapp.go.
      assert.strictEqual(regionFor('apps.contoso.com'), 'apps')
    })
  })

  describe('resource group extraction from WEBSITE_OWNER_NAME', () => {
    /** @param {string} ownerName */
    function resourceGroupFor (ownerName) {
      process.env.WEBSITE_SITE_NAME = 'site'
      process.env.WEBSITE_OWNER_NAME = ownerName
      return getAzureAppMetadata().resourceGroup
    }

    it('strips the -Linux suffix before splitting on the last dash', () => {
      assert.strictEqual(resourceGroupFor('sub+rg-regionwebspace-Linux'), 'rg')
    })

    it('preserves dashes inside the resource group', () => {
      assert.strictEqual(resourceGroupFor('sub+with-dashes-regionwebspace'), 'with-dashes')
    })

    it('extracts from the shortest accepted form', () => {
      assert.strictEqual(resourceGroupFor('a+b-cwebspace'), 'b')
    })

    it('returns undefined when WEBSITE_OWNER_NAME has no plus separator', () => {
      // Suffix is otherwise valid; pins the early `plusIdx === -1` guard.
      assert.strictEqual(resourceGroupFor('rg-regionwebspace'), undefined)
    })

    it('returns undefined when WEBSITE_OWNER_NAME does not end in webspace', () => {
      // Length is chosen so removing the `webspace` guard would otherwise return `'rg'`.
      assert.strictEqual(resourceGroupFor('sub+rg-something-region'), undefined)
    })

    it('returns undefined when no dash precedes the region marker', () => {
      assert.strictEqual(resourceGroupFor('sub+regionwebspace'), undefined)
    })
  })
})
