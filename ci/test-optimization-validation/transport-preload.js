'use strict'

/* eslint-disable eslint-rules/eslint-process-env */

const VALIDATION_INTAKE_URL_ENV = 'DD_TEST_OPTIMIZATION_VALIDATION_INTAKE_URL'
const intakeUrl = process.env[VALIDATION_INTAKE_URL_ENV]

if (intakeUrl) {
  const url = new URL(intakeUrl)
  const noProxy = new Set(
    `${process.env.NO_PROXY || ''},${process.env.no_proxy || ''}`
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
  )

  noProxy.add('127.0.0.1')
  noProxy.add('localhost')

  process.env.DD_AGENT_HOST = url.hostname
  process.env.DD_TRACE_AGENT_HOSTNAME = url.hostname
  process.env.DD_TRACE_AGENT_PORT = url.port
  process.env.DD_TRACE_AGENT_URL = intakeUrl
  process.env.DD_CIVISIBILITY_AGENTLESS_URL = intakeUrl
  process.env.NO_PROXY = [...noProxy].join(',')
  process.env.no_proxy = process.env.NO_PROXY
  delete process.env.DD_TRACE_AGENT_UNIX_DOMAIN_SOCKET
}
