const aws = require('./aws.json')
const sdks = { aws }

function getSDKRules (sdk, requestInput, responseInput) {
  return Object.fromEntries(
    Object.entries(sdk).map(([service, serviceRules]) => {
      return [
        service,
        {
          request: serviceRules.request.concat(requestInput || []),
          response: serviceRules.response.concat(responseInput || []),
          expand: serviceRules.expand || []
        }
      ]
    })
  )
}

function appendRules (requestInput, responseInput) {
  return Object.fromEntries(
    Object.entries(sdks).map(([name, sdk]) => {
      return [
        name,
        getSDKRules(sdk, requestInput, responseInput)
      ]
    })
  )
}

module.exports = { appendRules }
