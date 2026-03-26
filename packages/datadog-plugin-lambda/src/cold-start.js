'use strict'

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

function isManagedInstancesMode () {
  return process.env.AWS_LAMBDA_INITIALIZATION_TYPE === 'lambda-managed-instances'
}

function isProvisionedConcurrency () {
  return process.env.AWS_LAMBDA_INITIALIZATION_TYPE === 'provisioned-concurrency'
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
