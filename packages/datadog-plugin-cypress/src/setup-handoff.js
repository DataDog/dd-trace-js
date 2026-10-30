'use strict'

// Observe the actual setup serialization boundary without retaining ownership of process.send.
module.exports = function observeSetupHandoff (onHandoff) {
  const originalSend = process.send
  if (typeof originalSend !== 'function') return () => {}
  let active = true
  const stop = () => {
    active = false
    if (process.send === send) process.send = originalSend
  }
  const send = function (message) {
    let forwardedArguments = arguments
    if (active && (message?.event === 'setupTestingType:reply' || message?.event === 'setupTestingType:error')) {
      try {
        let wireConfig = message.event === 'setupTestingType:reply' && message.args?.[0]?.setupConfig
        const retriesDescriptor = wireConfig && typeof wireConfig === 'object' &&
          Object.getOwnPropertyDescriptor(wireConfig, 'retries')
        if (retriesDescriptor?.enumerable && retriesDescriptor.get) {
          // Match the single native wire read, then inspect and serialize those same values.
          wireConfig = { ...wireConfig }
          forwardedArguments = [...arguments]
          forwardedArguments[0] = {
            ...message,
            args: [{ ...message.args[0], setupConfig: wireConfig }, ...message.args.slice(1)],
          }
        }
        const returnedConfig = wireConfig?.[Symbol.for('dd-trace.cypress.returned-config')] ?? wireConfig
        onHandoff(returnedConfig, message.event)
      } finally {
        stop()
      }
    }
    return originalSend.apply(this, forwardedArguments)
  }
  process.send = send
  return stop
}
