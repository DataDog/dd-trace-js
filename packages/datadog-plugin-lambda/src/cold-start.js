'use strict'

const { getEnvironmentVariable } = require('../../dd-trace/src/config/helper')

let functionDidColdStart = true
let proactiveInitialization = false
let isColdStartSet = false

/**
 * @param {number} initTime
 * @param {number} invocationStartTime
 */
function setSandboxInit (initTime, invocationStartTime) {
  if (!isColdStartSet && invocationStartTime - initTime > 10_000) {
    proactiveInitialization = true
    functionDidColdStart = false
  } else {
    functionDidColdStart = !isColdStartSet
    proactiveInitialization = false
  }
  isColdStartSet = true
}

function didFunctionColdStart () {
  return functionDidColdStart
}

function isProactiveInitialization () {
  return proactiveInitialization
}

function getSandboxInitTags () {
  const tags = [`cold_start:${didFunctionColdStart()}`]
  if (isProactiveInitialization()) {
    tags.push('proactive_initialization:true')
  }
  return tags
}

const getInitializationType = () => getEnvironmentVariable('AWS_LAMBDA_INITIALIZATION_TYPE')

function isManagedInstancesMode () {
  return getInitializationType() === 'lambda-managed-instances'
}

function isProvisionedConcurrency () {
  return getInitializationType() === 'provisioned-concurrency'
}

function _resetColdStart () {
  functionDidColdStart = true
  proactiveInitialization = false
  isColdStartSet = false
}

module.exports = {
  setSandboxInit,
  didFunctionColdStart,
  isProactiveInitialization,
  getSandboxInitTags,
  isManagedInstancesMode,
  isProvisionedConcurrency,
  _resetColdStart,
}
