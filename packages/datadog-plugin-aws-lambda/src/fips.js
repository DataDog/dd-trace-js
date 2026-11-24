'use strict'

const { getEnvironmentVariable } = require('../../dd-trace/src/config/helper')

// The shim accepts only "true", whereas the general tracer boolean parser also accepts "1".
// Keep this private source contract until metrics configuration is wired into the Lambda lifecycle.
const AWS_REGION = getEnvironmentVariable('AWS_REGION') ?? ''
const rawFips = getEnvironmentVariable('DD_LAMBDA_FIPS_MODE') ?? (AWS_REGION.startsWith('us-gov-') ? 'true' : 'false')
const FIPS_MODE_ENABLED = rawFips.toLowerCase() === 'true'

module.exports = { AWS_REGION, FIPS_MODE_ENABLED }
