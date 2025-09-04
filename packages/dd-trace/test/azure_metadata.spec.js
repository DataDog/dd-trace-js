'use strict'

require('./setup/tap')

const os = require('os')
const { getAzureAppMetadata, getAzureTagsFromMetadata } = require('../src/azure_metadata')

describe('Azure metadata', () => {
  describe('for apps is', () => {
    it('not provided without WEBSITE_SITE_NAME', () => {
      delete process.env.WEBSITE_SITE_NAME
      expect(getAzureAppMetadata()).to.be.undefined
    })

    it('provided with WEBSITE_SITE_NAME', () => {
      delete process.env.COMPUTERNAME // actually defined on Windows
      process.env.WEBSITE_SITE_NAME = 'website_name'
      expect(getAzureAppMetadata()).to.deep.equal({
        operatingSystem: os.platform(), siteKind: 'app', siteName: 'website_name', siteType: 'app'
      })
    })
  })

  it('provided completely with minimum vars', () => {
    delete process.env.WEBSITE_RESOURCE_GROUP
    delete process.env.WEBSITE_OS
    delete process.env.FUNCTIONS_EXTENSION_VERSION
    delete process.env.FUNCTIONS_WORKER_RUNTIME
    delete process.env.FUNCTIONS_WORKER_RUNTIME_VERSION
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
    expect(getAzureAppMetadata()).to.deep.equal(expected)
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
    expect(getAzureAppMetadata()).to.deep.equal(expected)
  })

  it('tags are correctly generated from vars', () => {
    delete process.env.WEBSITE_RESOURCE_GROUP
    delete process.env.WEBSITE_OS
    delete process.env.FUNCTIONS_EXTENSION_VERSION
    delete process.env.FUNCTIONS_WORKER_RUNTIME
    delete process.env.FUNCTIONS_WORKER_RUNTIME_VERSION
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
    expect(getAzureTagsFromMetadata(getAzureAppMetadata())).to.deep.equal(expected)
  })
})
