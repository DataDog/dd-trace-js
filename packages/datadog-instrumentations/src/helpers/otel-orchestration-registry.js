'use strict'

// Maps durable instance IDs to in-flight orchestration OTel spans so activity
// spans can parent directly to the orchestration span instead of Azure-internal
// W3C parent IDs that are never exported to Datadog.
const orchestrationSpansByInstance = new Map()

function registerOrchestrationSpan (instanceId, span) {
  if (instanceId && span) {
    orchestrationSpansByInstance.set(instanceId, span)
  }
}

function unregisterOrchestrationSpan (instanceId) {
  if (instanceId) {
    orchestrationSpansByInstance.delete(instanceId)
  }
}

function getOrchestrationSpan (instanceId) {
  return instanceId ? orchestrationSpansByInstance.get(instanceId) : undefined
}

module.exports = {
  getOrchestrationSpan,
  registerOrchestrationSpan,
  unregisterOrchestrationSpan,
}
