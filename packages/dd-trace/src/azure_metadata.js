'use strict'

// eslint-disable-next-line @stylistic/js/max-len
// Modeled after https://github.com/DataDog/libdatadog/blob/f3994857a59bb5679a65967138c5a3aec418a65f/ddcommon/src/azure_app_services.rs

const os = require('os')
const { getIsAzureFunction } = require('./serverless')

function extractSubscriptionID (ownerName) {
  if (ownerName !== undefined) {
    const subId = ownerName.split('+')[0].trim()
    if (subId.length > 0) {
      return subId
    }
  }
  return undefined
}

function extractResourceGroup (ownerName) {
  return /.+\+(.+)-.+webspace(-Linux)?/.exec(ownerName)?.[1]
}

function buildResourceID (subscriptionID, siteName, resourceGroup) {
  if (subscriptionID === undefined || siteName === undefined || resourceGroup === undefined) {
    return undefined
  }
  return `/subscriptions/${subscriptionID}/resourcegroups/${resourceGroup}/providers/microsoft.web/sites/${siteName}`
    .toLowerCase()
}

function trimObject (obj) {
  Object.entries(obj)
    .filter(([_, value]) => value === undefined)
    .forEach(([key, _]) => { delete obj[key] })
  return obj
}

function buildMetadata () {
  const {
    COMPUTERNAME,
    DD_AAS_DOTNET_EXTENSION_VERSION,
    FUNCTIONS_EXTENSION_VERSION,
    FUNCTIONS_WORKER_RUNTIME,
    FUNCTIONS_WORKER_RUNTIME_VERSION,
    WEBSITE_INSTANCE_ID,
    WEBSITE_OWNER_NAME,
    WEBSITE_OS,
    WEBSITE_RESOURCE_GROUP,
    WEBSITE_SITE_NAME
  } = process.env

  const subscriptionID = extractSubscriptionID(WEBSITE_OWNER_NAME)

  const siteName = WEBSITE_SITE_NAME

  const [siteKind, siteType] = getIsAzureFunction()
    ? ['functionapp', 'function']
    : ['app', 'app']

  const resourceGroup = WEBSITE_RESOURCE_GROUP ?? extractResourceGroup(WEBSITE_OWNER_NAME)

  return trimObject({
    extensionVersion: DD_AAS_DOTNET_EXTENSION_VERSION,
    functionRuntimeVersion: FUNCTIONS_EXTENSION_VERSION,
    instanceID: WEBSITE_INSTANCE_ID,
    instanceName: COMPUTERNAME,
    operatingSystem: WEBSITE_OS ?? os.platform(),
    resourceGroup,
    resourceID: buildResourceID(subscriptionID, siteName, resourceGroup),
    runtime: FUNCTIONS_WORKER_RUNTIME,
    runtimeVersion: FUNCTIONS_WORKER_RUNTIME_VERSION,
    siteKind,
    siteName,
    siteType,
    subscriptionID
  })
}

function getAzureAppMetadata () {
  // DD_AZURE_APP_SERVICES is an environment variable introduced by the .NET APM team and is set automatically for
  // anyone using the Datadog APM Extensions (.NET, Java, or Node) for Windows Azure App Services
  // eslint-disable-next-line @stylistic/js/max-len
  // See: https://github.com/DataDog/datadog-aas-extension/blob/01f94b5c28b7fa7a9ab264ca28bd4e03be603900/node/src/applicationHost.xdt#L20-L21
  return process.env.DD_AZURE_APP_SERVICES !== undefined ? buildMetadata() : undefined
}

function getAzureFunctionMetadata () {
  return getIsAzureFunction() ? buildMetadata() : undefined
}

// eslint-disable-next-line @stylistic/js/max-len
// Modeled after https://github.com/DataDog/libdatadog/blob/92272e90a7919f07178f3246ef8f82295513cfed/profiling/src/exporter/mod.rs#L187
// eslint-disable-next-line @stylistic/js/max-len
// and https://github.com/DataDog/libdatadog/blob/f3994857a59bb5679a65967138c5a3aec418a65f/trace-utils/src/trace_utils.rs#L533
function getAzureTagsFromMetadata (metadata) {
  if (metadata === undefined) {
    return {}
  }
  return trimObject({
    'aas.environment.extension_version': metadata.extensionVersion,
    'aas.environment.function_runtime': metadata.functionRuntimeVersion,
    'aas.environment.instance_id': metadata.instanceID,
    'aas.environment.instance_name': metadata.instanceName,
    'aas.environment.os': metadata.operatingSystem,
    'aas.environment.runtime': metadata.runtime,
    'aas.environment.runtime_version': metadata.runtimeVersion,
    'aas.resource.group': metadata.resourceGroup,
    'aas.resource.id': metadata.resourceID,
    'aas.site.kind': metadata.siteKind,
    'aas.site.name': metadata.siteName,
    'aas.site.type': metadata.siteType,
    'aas.subscription.id': metadata.subscriptionID
  })
}

module.exports = {
  getAzureAppMetadata,
  getAzureFunctionMetadata,
  getAzureTagsFromMetadata
}
