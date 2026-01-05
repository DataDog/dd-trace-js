'use strict'

const assert = require('node:assert/strict')
const os = require('node:os')

const { describe, it, afterEach } = require('mocha')

require('./setup/core')
const { getAzureAppMetadata, getAzureTagsFromMetadata, getAzureFunctionMetadata } = require('../src/azure_metadata')

describe('Azure metadata', () => {
  const AZURE_ENV_KEYS = [
    'COMPUTERNAME',
    'DD_AAS_DOTNET_EXTENSION_VERSION',
    'DD_AZURE_RESOURCE_GROUP',
    'FUNCTIONS_EXTENSION_VERSION',
    'FUNCTIONS_WORKER_RUNTIME',
    'FUNCTIONS_WORKER_RUNTIME_VERSION',
    'WEBSITE_INSTANCE_ID',
    'WEBSITE_OWNER_NAME',
    'WEBSITE_OS',
    'WEBSITE_RESOURCE_GROUP',
    'WEBSITE_SITE_NAME',
    'WEBSITE_SKU'
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
        operatingSystem: os.platform(), siteKind: 'app', siteName: 'website_name', siteType: 'app'
      })
    })
  })

  it('provided completely with minimum vars', () => {
    process.env.COMPUTERNAME = 'boaty_mcboatface'
    process.env.WEBSITE_SITE_NAME = 'website_name'
    process.env.WEBSITE_OWNER_NAME = 'subscription_id+resource_group-regionwebspace'
    process.env.WEBSITE_INSTANCE_ID = 'instance_id'
    process.env.DD_AAS_DOTNET_EXTENSION_VERSION = '1.0'
    const expected = {
      extensionVersion: '1.0',
      instanceID: 'instance_id',
      instanceName: 'boaty_mcboatface',
      operatingSystem: os.platform(),
      resourceGroup: 'resource_group',
      resourceID:
        '/subscriptions/subscription_id/resourcegroups/resource_group/providers/microsoft.web/sites/website_name',
      siteKind: 'app',
      siteName: 'website_name',
      siteType: 'app',
      subscriptionID: 'subscription_id'
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
    process.env.DD_AAS_DOTNET_EXTENSION_VERSION = '1.0'
    const expected = {
      extensionVersion: '1.0',
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
      subscriptionID: 'subscription_id'
    }
    assert.deepStrictEqual(getAzureAppMetadata(), expected)
  })

  it('tags are correctly generated from vars', () => {
    process.env.COMPUTERNAME = 'boaty_mcboatface'
    process.env.WEBSITE_SITE_NAME = 'website_name'
    process.env.WEBSITE_OWNER_NAME = 'subscription_id+resource_group-regionwebspace'
    process.env.WEBSITE_INSTANCE_ID = 'instance_id'
    process.env.DD_AAS_DOTNET_EXTENSION_VERSION = '1.0'
    const expected = {
      'aas.environment.extension_version': '1.0',
      'aas.environment.instance_id': 'instance_id',
      'aas.environment.instance_name': 'boaty_mcboatface',
      'aas.environment.os': os.platform(),
      'aas.resource.group': 'resource_group',
      'aas.resource.id':
        '/subscriptions/subscription_id/resourcegroups/resource_group/providers/microsoft.web/sites/website_name',
      'aas.site.kind': 'app',
      'aas.site.name': 'website_name',
      'aas.site.type': 'app',
      'aas.subscription.id': 'subscription_id'
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
      subscriptionID: 'subscription_id'
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
})
