'use strict'

// Modeled after https://github.com/DataDog/libdatadog/blob/f3994857a59bb5679a65967138c5a3aec418a65f/ddcommon/src/azure_app_services.rs

const os = require('os')
const {
  getEnvironmentVariable,
  getValueFromEnvSources,
} = require('./config/helper')
const { getIsAzureFunction } = require('./serverless')

function extractSubscriptionID (ownerName) {
  if (ownerName !== undefined) {
    const subId = ownerName.split('+')[0].trim()
    if (subId.length > 0) {
      return subId
    }
  }
}

function extractResourceGroup (ownerName) {
  return /.+\+(.+)-.+webspace(-Linux)?/.exec(ownerName)?.[1]
}

function buildResourceID (subscriptionID, siteName, resourceGroup) {
  if (subscriptionID === undefined || siteName === undefined || resourceGroup === undefined) {
    return
  }
  return `/subscriptions/${subscriptionID}/resourcegroups/${resourceGroup}/providers/microsoft.web/sites/${siteName}`
    .toLowerCase()
}

/**
 * @param {Record<string | symbol, unknown>} obj
 * @returns {Partial<Record<string | symbol, unknown>>}
 */
function trimObject (obj) {
  const cleanedObj = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      cleanedObj[key] = value
    }
  }
  return cleanedObj
}

function buildMetadata () {
  const COMPUTERNAME = getEnvironmentVariable('COMPUTERNAME')
  const FUNCTIONS_EXTENSION_VERSION = getEnvironmentVariable('FUNCTIONS_EXTENSION_VERSION')
  const FUNCTIONS_WORKER_RUNTIME = getEnvironmentVariable('FUNCTIONS_WORKER_RUNTIME')
  const FUNCTIONS_WORKER_RUNTIME_VERSION = getEnvironmentVariable('FUNCTIONS_WORKER_RUNTIME_VERSION')
  const WEBSITE_INSTANCE_ID = getEnvironmentVariable('WEBSITE_INSTANCE_ID')
  const WEBSITE_OWNER_NAME = getEnvironmentVariable('WEBSITE_OWNER_NAME')
  const WEBSITE_OS = getEnvironmentVariable('WEBSITE_OS')
  const WEBSITE_RESOURCE_GROUP = getEnvironmentVariable('WEBSITE_RESOURCE_GROUP')
  const WEBSITE_SITE_NAME = getEnvironmentVariable('WEBSITE_SITE_NAME')
  const WEBSITE_SKU = getEnvironmentVariable('WEBSITE_SKU')

  const DD_AZURE_RESOURCE_GROUP = getValueFromEnvSources('DD_AZURE_RESOURCE_GROUP')
  const isAzureFunction = FUNCTIONS_EXTENSION_VERSION !== undefined && FUNCTIONS_WORKER_RUNTIME !== undefined
  const isFlexConsumptionAzureFunction = isAzureFunction && WEBSITE_SKU === 'FlexConsumption'

  const subscriptionID = extractSubscriptionID(WEBSITE_OWNER_NAME)

  const siteName = WEBSITE_SITE_NAME

  const [siteKind, siteType] = isAzureFunction
    ? ['functionapp', 'function']
    : ['app', 'app']

  // Azure Functions on Flex Consumption plans require the `DD_AZURE_RESOURCE_GROUP` env var.
  // If this logic ever changes, update the logic in `libdatadog`, `serverless-components/src/datadog-trace-agent`,
  // and the serverless compat layers accordingly.
  const resourceGroup = isFlexConsumptionAzureFunction
    ? (DD_AZURE_RESOURCE_GROUP ?? WEBSITE_RESOURCE_GROUP ?? extractResourceGroup(WEBSITE_OWNER_NAME))
    : (WEBSITE_RESOURCE_GROUP ?? extractResourceGroup(WEBSITE_OWNER_NAME))

  return trimObject({
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
    subscriptionID,
  })
}

function getAzureAppMetadata () {
  // WEBSITE_SITE_NAME is the unique name of the website instance within Azure App Services. Its
  // presence is used to determine if we are running in Azure App Service
  // See equivalent in dd-trace-dotnet:
  // https://github.com/DataDog/dd-trace-dotnet/blob/37030168b2996e549ba23231ae732874b53a37e6/tracer/src/Datadog.Trace/Util/EnvironmentHelpers.cs#L99-L155
  if (getEnvironmentVariable('WEBSITE_SITE_NAME') !== undefined) {
    return buildMetadata()
  }
}

function getAzureFunctionMetadata () {
  if (getIsAzureFunction()) {
    return buildMetadata()
  }
}

// Modeled after https://github.com/DataDog/libdatadog/blob/92272e90a7919f07178f3246ef8f82295513cfed/profiling/src/exporter/mod.rs#L187
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
    'aas.subscription.id': metadata.subscriptionID,
  })
}

module.exports = {
  getAzureAppMetadata,
  getAzureFunctionMetadata,
  getAzureTagsFromMetadata,
}
