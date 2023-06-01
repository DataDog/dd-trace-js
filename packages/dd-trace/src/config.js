'use strict'

const fs = require('fs')
const os = require('os')
const uuid = require('crypto-randomuuid')
const URL = require('url').URL
const log = require('./log')
const pkg = require('./pkg')
const coalesce = require('koalas')
const tagger = require('./tagger')
const { isTrue, isFalse } = require('./util')
const { GIT_REPOSITORY_URL, GIT_COMMIT_SHA } = require('./plugins/util/tags')
const { getGitMetadataFromGitProperties } = require('./git_properties')

const fromEntries = Object.fromEntries || (entries =>
  entries.reduce((obj, [k, v]) => Object.assign(obj, { [k]: v }), {}))

function maybeFile (filepath) {
  if (!filepath) return
  try {
    return fs.readFileSync(filepath, 'utf8')
  } catch (e) {
    log.error(e)
    return undefined
  }
}

function safeJsonParse (input) {
  try {
    return JSON.parse(input)
  } catch (err) {
    return undefined
  }
}

const namingVersions = ['v0', 'v1']
const defaultNamingVersion = 'v0'

function validateNamingVersion (versionString) {
  if (!versionString) {
    return defaultNamingVersion
  }
  if (!namingVersions.includes(versionString)) {
    log.warn(
      `Unexpected input for config.spanAttributeSchema, picked default ${defaultNamingVersion}`
    )
    return defaultNamingVersion
  }
  return versionString
}

// Shallow clone with property name remapping
function remapify (input, mappings) {
  if (!input) return
  const output = {}
  for (const [key, value] of Object.entries(input)) {
    output[key in mappings ? mappings[key] : key] = value
  }
  return output
}

function propagationStyle (key, option, defaultValue) {
  // Extract by key if in object-form value
  if (typeof option === 'object' && !Array.isArray(option)) {
    option = option[key]
  }

  // Should be an array at this point
  if (Array.isArray(option)) return option.map(v => v.toLowerCase())

  // If it's not an array but not undefined there's something wrong with the input
  if (typeof option !== 'undefined') {
    log.warn('Unexpected input for config.tracePropagationStyle')
  }

  // Otherwise, fallback to env var parsing
  const envKey = `DD_TRACE_PROPAGATION_STYLE_${key.toUpperCase()}`
  const envVar = coalesce(process.env[envKey], process.env.DD_TRACE_PROPAGATION_STYLE)
  if (typeof envVar !== 'undefined') {
    return envVar.split(',')
      .filter(v => v !== '')
      .map(v => v.trim().toLowerCase())
  }

  return defaultValue
}

class Config {
  constructor (options) {
    options = options || {}

    // Configure the logger first so it can be used to warn about other configs
    this.debug = isTrue(coalesce(
      process.env.DD_TRACE_DEBUG,
      false
    ))
    this.logger = options.logger
    this.logLevel = coalesce(
      options.logLevel,
      process.env.DD_TRACE_LOG_LEVEL,
      'debug'
    )

    log.use(this.logger)
    log.toggle(this.debug, this.logLevel, this)

    this.tags = {}

    tagger.add(this.tags, process.env.DD_TAGS)
    tagger.add(this.tags, process.env.DD_TRACE_TAGS)
    tagger.add(this.tags, process.env.DD_TRACE_GLOBAL_TAGS)
    tagger.add(this.tags, options.tags)

    const DD_TRACING_ENABLED = coalesce(
      process.env.DD_TRACING_ENABLED,
      true
    )
    const DD_PROFILING_ENABLED = coalesce(
      options.profiling, // TODO: remove when enabled by default
      process.env.DD_EXPERIMENTAL_PROFILING_ENABLED,
      process.env.DD_PROFILING_ENABLED,
      false
    )
    const DD_PROFILING_EXPORTERS = coalesce(
      process.env.DD_PROFILING_EXPORTERS,
      'agent'
    )
    const DD_PROFILING_SOURCE_MAP = process.env.DD_PROFILING_SOURCE_MAP
    const DD_LOGS_INJECTION = coalesce(
      options.logInjection,
      process.env.DD_LOGS_INJECTION,
      false
    )
    const DD_RUNTIME_METRICS_ENABLED = coalesce(
      options.runtimeMetrics, // TODO: remove when enabled by default
      process.env.DD_RUNTIME_METRICS_ENABLED,
      false
    )
    const DD_DBM_PROPAGATION_MODE = coalesce(
      options.dbmPropagationMode,
      process.env.DD_DBM_PROPAGATION_MODE,
      'disabled'
    )
    const DD_AGENT_HOST = coalesce(
      options.hostname,
      process.env.DD_AGENT_HOST,
      process.env.DD_TRACE_AGENT_HOSTNAME,
      '127.0.0.1'
    )
    const DD_TRACE_AGENT_PORT = coalesce(
      options.port,
      process.env.DD_TRACE_AGENT_PORT,
      '8126'
    )
    const DD_TRACE_AGENT_URL = coalesce(
      options.url,
      process.env.DD_TRACE_AGENT_URL,
      process.env.DD_TRACE_URL,
      null
    )
    const DD_IS_CIVISIBILITY = coalesce(
      options.isCiVisibility,
      false
    )
    const DD_CIVISIBILITY_AGENTLESS_URL = process.env.DD_CIVISIBILITY_AGENTLESS_URL

    const DD_CIVISIBILITY_ITR_ENABLED = coalesce(
      process.env.DD_CIVISIBILITY_ITR_ENABLED,
      true
    )

    const DD_SERVICE = options.service ||
      process.env.DD_SERVICE ||
      process.env.DD_SERVICE_NAME ||
      this.tags.service ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.FUNCTION_NAME || // Google Cloud Function Name set by deprecated runtimes
      process.env.K_SERVICE || // Google Cloud Function Name set by newer runtimes
      pkg.name ||
      'node'
    const DD_SERVICE_MAPPING = coalesce(
      options.serviceMapping,
      process.env.DD_SERVICE_MAPPING ? fromEntries(
        process.env.DD_SERVICE_MAPPING.split(',').map(x => x.trim().split(':'))
      ) : {}
    )
    const DD_ENV = coalesce(
      options.env,
      process.env.DD_ENV,
      this.tags.env
    )
    const DD_VERSION = coalesce(
      options.version,
      process.env.DD_VERSION,
      this.tags.version,
      pkg.version
    )
    const DD_TRACE_STARTUP_LOGS = coalesce(
      options.startupLogs,
      process.env.DD_TRACE_STARTUP_LOGS,
      false
    )

    const inAWSLambda = process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined

    const isDeprecatedGCPFunction = process.env.FUNCTION_NAME !== undefined && process.env.GCP_PROJECT !== undefined
    const isNewerGCPFunction = process.env.K_SERVICE !== undefined && process.env.FUNCTION_TARGET !== undefined
    const isGCPFunction = isDeprecatedGCPFunction || isNewerGCPFunction

    const inServerlessEnvironment = inAWSLambda || isGCPFunction

    const DD_TRACE_TELEMETRY_ENABLED = coalesce(
      process.env.DD_TRACE_TELEMETRY_ENABLED,
      !inServerlessEnvironment
    )
    const DD_TELEMETRY_DEBUG_ENABLED = coalesce(
      process.env.DD_TELEMETRY_DEBUG_ENABLED,
      false
    )
    const DD_TRACE_AGENT_PROTOCOL_VERSION = coalesce(
      options.protocolVersion,
      process.env.DD_TRACE_AGENT_PROTOCOL_VERSION,
      '0.4'
    )
    const DD_TRACE_PARTIAL_FLUSH_MIN_SPANS = coalesce(
      parseInt(options.flushMinSpans),
      parseInt(process.env.DD_TRACE_PARTIAL_FLUSH_MIN_SPANS),
      1000
    )
    const DD_TRACE_CLIENT_IP_ENABLED = coalesce(
      options.clientIpEnabled,
      process.env.DD_TRACE_CLIENT_IP_ENABLED && isTrue(process.env.DD_TRACE_CLIENT_IP_ENABLED),
      false
    )
    const DD_TRACE_CLIENT_IP_HEADER = coalesce(
      options.clientIpHeader,
      process.env.DD_TRACE_CLIENT_IP_HEADER,
      null
    )
    const DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP = coalesce(
      process.env.DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP,
      '.*'
    )
    // TODO: Remove the experimental env vars as a major?
    const DD_TRACE_B3_ENABLED = coalesce(
      options.experimental && options.experimental.b3,
      process.env.DD_TRACE_EXPERIMENTAL_B3_ENABLED,
      false
    )
    const defaultPropagationStyle = ['tracecontext', 'datadog']
    if (isTrue(DD_TRACE_B3_ENABLED)) {
      defaultPropagationStyle.push('b3')
      defaultPropagationStyle.push('b3 single header')
    }
    if (process.env.DD_TRACE_PROPAGATION_STYLE && (
      process.env.DD_TRACE_PROPAGATION_STYLE_INJECT ||
      process.env.DD_TRACE_PROPAGATION_STYLE_EXTRACT
    )) {
      log.warn(
        'Use either the DD_TRACE_PROPAGATION_STYLE environment variable or separate ' +
        'DD_TRACE_PROPAGATION_STYLE_INJECT and DD_TRACE_PROPAGATION_STYLE_EXTRACT ' +
        'environment variables'
      )
    }
    const DD_TRACE_PROPAGATION_STYLE_INJECT = propagationStyle(
      'inject',
      options.tracePropagationStyle,
      defaultPropagationStyle
    )
    const DD_TRACE_PROPAGATION_STYLE_EXTRACT = propagationStyle(
      'extract',
      options.tracePropagationStyle,
      defaultPropagationStyle
    )
    const DD_TRACE_RUNTIME_ID_ENABLED = coalesce(
      options.experimental && options.experimental.runtimeId,
      process.env.DD_TRACE_EXPERIMENTAL_RUNTIME_ID_ENABLED,
      false
    )
    const DD_TRACE_EXPORTER = coalesce(
      options.experimental && options.experimental.exporter,
      process.env.DD_TRACE_EXPERIMENTAL_EXPORTER
    )
    const DD_TRACE_GET_RUM_DATA_ENABLED = coalesce(
      options.experimental && options.experimental.enableGetRumData,
      process.env.DD_TRACE_EXPERIMENTAL_GET_RUM_DATA_ENABLED,
      false
    )
    const DD_TRACE_SPAN_ATTRIBUTE_SCHEMA = validateNamingVersion(
      process.env.DD_TRACE_SPAN_ATTRIBUTE_SCHEMA
    )
    const DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH = coalesce(
      process.env.DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH,
      '512'
    )

    const DD_TRACE_STATS_COMPUTATION_ENABLED = coalesce(
      options.stats,
      process.env.DD_TRACE_STATS_COMPUTATION_ENABLED,
      isGCPFunction
    )

    const DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED = coalesce(
      options.traceId128BitGenerationEnabled,
      process.env.DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED,
      false
    )

    const DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED = coalesce(
      options.traceId128BitLoggingEnabled,
      process.env.DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED,
      false
    )

    let appsec = options.appsec != null ? options.appsec : options.experimental && options.experimental.appsec

    if (typeof appsec === 'boolean') {
      appsec = {
        enabled: appsec
      }
    } else if (appsec == null) {
      appsec = {}
    }

    const DD_APPSEC_ENABLED = coalesce(
      appsec.enabled,
      process.env.DD_APPSEC_ENABLED && isTrue(process.env.DD_APPSEC_ENABLED)
    )

    const DD_APPSEC_RULES = coalesce(
      appsec.rules,
      process.env.DD_APPSEC_RULES
    )
    const DD_APPSEC_TRACE_RATE_LIMIT = coalesce(
      parseInt(appsec.rateLimit),
      parseInt(process.env.DD_APPSEC_TRACE_RATE_LIMIT),
      100
    )
    const DD_APPSEC_WAF_TIMEOUT = coalesce(
      parseInt(appsec.wafTimeout),
      parseInt(process.env.DD_APPSEC_WAF_TIMEOUT),
      5e3 // µs
    )
    const DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP = coalesce(
      appsec.obfuscatorKeyRegex,
      process.env.DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP,
      `(?i)(?:p(?:ass)?w(?:or)?d|pass(?:_?phrase)?|secret|(?:api_?|private_?|public_?)key)|token|consumer_?(?:id|key|se\
cret)|sign(?:ed|ature)|bearer|authorization`
    )
    const DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP = coalesce(
      appsec.obfuscatorValueRegex,
      process.env.DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP,
      `(?i)(?:p(?:ass)?w(?:or)?d|pass(?:_?phrase)?|secret|(?:api_?|private_?|public_?|access_?|secret_?)key(?:_?id)?|to\
ken|consumer_?(?:id|key|secret)|sign(?:ed|ature)?|auth(?:entication|orization)?)(?:\\s*=[^;]|"\\s*:\\s*"[^"]+")|bearer\
\\s+[a-z0-9\\._\\-]+|token:[a-z0-9]{13}|gh[opsu]_[0-9a-zA-Z]{36}|ey[I-L][\\w=-]+\\.ey[I-L][\\w=-]+(?:\\.[\\w.+\\/=-]+)?\
|[\\-]{5}BEGIN[a-z\\s]+PRIVATE\\sKEY[\\-]{5}[^\\-]+[\\-]{5}END[a-z\\s]+PRIVATE\\sKEY|ssh-rsa\\s*[a-z0-9\\/\\.+]{100,}`
    )
    const DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML = coalesce(
      maybeFile(appsec.blockedTemplateHtml),
      maybeFile(process.env.DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML)
    )
    const DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON = coalesce(
      maybeFile(appsec.blockedTemplateJson),
      maybeFile(process.env.DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON)
    )

    const remoteConfigOptions = options.remoteConfig || {}
    const DD_REMOTE_CONFIGURATION_ENABLED = coalesce(
      process.env.DD_REMOTE_CONFIGURATION_ENABLED && isTrue(process.env.DD_REMOTE_CONFIGURATION_ENABLED),
      !inServerlessEnvironment
    )
    const DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS = coalesce(
      parseInt(remoteConfigOptions.pollInterval),
      parseInt(process.env.DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS),
      5 // seconds
    )

    const iastOptions = options.experimental && options.experimental.iast
    const DD_IAST_ENABLED = coalesce(
      iastOptions &&
      (iastOptions === true || iastOptions.enabled === true),
      process.env.DD_IAST_ENABLED,
      false
    )
    const DD_TELEMETRY_LOG_COLLECTION_ENABLED = coalesce(
      process.env.DD_TELEMETRY_LOG_COLLECTION_ENABLED,
      DD_IAST_ENABLED
    )

    const defaultIastRequestSampling = 30
    const iastRequestSampling = coalesce(
      parseInt(iastOptions && iastOptions.requestSampling),
      parseInt(process.env.DD_IAST_REQUEST_SAMPLING),
      defaultIastRequestSampling
    )
    const DD_IAST_REQUEST_SAMPLING = iastRequestSampling < 0 ||
      iastRequestSampling > 100 ? defaultIastRequestSampling : iastRequestSampling

    const DD_IAST_MAX_CONCURRENT_REQUESTS = coalesce(
      parseInt(iastOptions && iastOptions.maxConcurrentRequests),
      parseInt(process.env.DD_IAST_MAX_CONCURRENT_REQUESTS),
      2
    )

    const DD_IAST_MAX_CONTEXT_OPERATIONS = coalesce(
      parseInt(iastOptions && iastOptions.maxContextOperations),
      parseInt(process.env.DD_IAST_MAX_CONTEXT_OPERATIONS),
      2
    )

    const DD_IAST_DEDUPLICATION_ENABLED = coalesce(
      iastOptions && iastOptions.deduplicationEnabled,
      process.env.DD_IAST_DEDUPLICATION_ENABLED && isTrue(process.env.DD_IAST_DEDUPLICATION_ENABLED),
      true
    )

    const DD_IAST_REDACTION_ENABLED = coalesce(
      iastOptions && iastOptions.redactionEnabled,
      !isFalse(process.env.DD_IAST_REDACTION_ENABLED),
      true
    )

    const DD_CIVISIBILITY_GIT_UPLOAD_ENABLED = coalesce(
      process.env.DD_CIVISIBILITY_GIT_UPLOAD_ENABLED,
      true
    )

    const DD_TRACE_GIT_METADATA_ENABLED = coalesce(
      process.env.DD_TRACE_GIT_METADATA_ENABLED,
      true
    )

    const ingestion = options.ingestion || {}
    const dogstatsd = coalesce(options.dogstatsd, {})
    const sampler = {
      sampleRate: coalesce(
        options.sampleRate,
        process.env.DD_TRACE_SAMPLE_RATE,
        ingestion.sampleRate
      ),
      rateLimit: coalesce(options.rateLimit, process.env.DD_TRACE_RATE_LIMIT, ingestion.rateLimit),
      rules: coalesce(
        options.samplingRules,
        safeJsonParse(process.env.DD_TRACE_SAMPLING_RULES),
        []
      ).map(rule => {
        return remapify(rule, {
          sample_rate: 'sampleRate'
        })
      }),
      spanSamplingRules: coalesce(
        options.spanSamplingRules,
        safeJsonParse(maybeFile(process.env.DD_SPAN_SAMPLING_RULES_FILE)),
        safeJsonParse(process.env.DD_SPAN_SAMPLING_RULES),
        []
      ).map(rule => {
        return remapify(rule, {
          sample_rate: 'sampleRate',
          max_per_second: 'maxPerSecond'
        })
      })
    }

    const defaultFlushInterval = inServerlessEnvironment ? 0 : 2000

    this.tracing = !isFalse(DD_TRACING_ENABLED)
    this.dbmPropagationMode = DD_DBM_PROPAGATION_MODE
    this.logInjection = isTrue(DD_LOGS_INJECTION)
    this.env = DD_ENV
    this.url = DD_CIVISIBILITY_AGENTLESS_URL ? new URL(DD_CIVISIBILITY_AGENTLESS_URL)
      : getAgentUrl(DD_TRACE_AGENT_URL, options)
    this.site = coalesce(options.site, process.env.DD_SITE, 'datadoghq.com')
    this.hostname = DD_AGENT_HOST || (this.url && this.url.hostname)
    this.port = String(DD_TRACE_AGENT_PORT || (this.url && this.url.port))
    this.flushInterval = coalesce(parseInt(options.flushInterval, 10), defaultFlushInterval)
    this.flushMinSpans = DD_TRACE_PARTIAL_FLUSH_MIN_SPANS
    this.sampleRate = coalesce(Math.min(Math.max(sampler.sampleRate, 0), 1), 1)
    this.queryStringObfuscation = DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP
    this.clientIpEnabled = DD_TRACE_CLIENT_IP_ENABLED
    this.clientIpHeader = DD_TRACE_CLIENT_IP_HEADER
    this.plugins = !!coalesce(options.plugins, true)
    this.service = DD_SERVICE
    this.serviceMapping = DD_SERVICE_MAPPING
    this.version = DD_VERSION
    this.dogstatsd = {
      hostname: coalesce(dogstatsd.hostname, process.env.DD_DOGSTATSD_HOSTNAME, this.hostname),
      port: String(coalesce(dogstatsd.port, process.env.DD_DOGSTATSD_PORT, 8125))
    }
    this.runtimeMetrics = isTrue(DD_RUNTIME_METRICS_ENABLED)
    this.tracePropagationStyle = {
      inject: DD_TRACE_PROPAGATION_STYLE_INJECT,
      extract: DD_TRACE_PROPAGATION_STYLE_EXTRACT
    }
    this.experimental = {
      runtimeId: isTrue(DD_TRACE_RUNTIME_ID_ENABLED),
      exporter: DD_TRACE_EXPORTER,
      enableGetRumData: isTrue(DD_TRACE_GET_RUM_DATA_ENABLED)
    }
    this.sampler = sampler
    this.reportHostname = isTrue(coalesce(options.reportHostname, process.env.DD_TRACE_REPORT_HOSTNAME, false))
    this.scope = process.env.DD_TRACE_SCOPE
    this.profiling = {
      enabled: isTrue(DD_PROFILING_ENABLED),
      sourceMap: !isFalse(DD_PROFILING_SOURCE_MAP),
      exporters: DD_PROFILING_EXPORTERS
    }
    this.spanAttributeSchema = DD_TRACE_SPAN_ATTRIBUTE_SCHEMA
    this.lookup = options.lookup
    this.startupLogs = isTrue(DD_TRACE_STARTUP_LOGS)
    // Disabled for CI Visibility's agentless
    this.telemetry = {
      enabled: DD_TRACE_EXPORTER !== 'datadog' && isTrue(DD_TRACE_TELEMETRY_ENABLED),
      logCollection: isTrue(DD_TELEMETRY_LOG_COLLECTION_ENABLED),
      debug: isTrue(DD_TELEMETRY_DEBUG_ENABLED)
    }
    this.protocolVersion = DD_TRACE_AGENT_PROTOCOL_VERSION
    this.tagsHeaderMaxLength = parseInt(DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH)
    this.appsec = {
      enabled: DD_APPSEC_ENABLED,
      rules: DD_APPSEC_RULES ? safeJsonParse(maybeFile(DD_APPSEC_RULES)) : require('./appsec/recommended.json'),
      customRulesProvided: !!DD_APPSEC_RULES,
      rateLimit: DD_APPSEC_TRACE_RATE_LIMIT,
      wafTimeout: DD_APPSEC_WAF_TIMEOUT,
      obfuscatorKeyRegex: DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP,
      obfuscatorValueRegex: DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP,
      blockedTemplateHtml: DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML,
      blockedTemplateJson: DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON
    }
    this.remoteConfig = {
      enabled: DD_REMOTE_CONFIGURATION_ENABLED,
      pollInterval: DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS
    }
    this.iast = {
      enabled: isTrue(DD_IAST_ENABLED),
      requestSampling: DD_IAST_REQUEST_SAMPLING,
      maxConcurrentRequests: DD_IAST_MAX_CONCURRENT_REQUESTS,
      maxContextOperations: DD_IAST_MAX_CONTEXT_OPERATIONS,
      deduplicationEnabled: DD_IAST_DEDUPLICATION_ENABLED,
      redactionEnabled: DD_IAST_REDACTION_ENABLED
    }

    this.isCiVisibility = isTrue(DD_IS_CIVISIBILITY)

    this.isIntelligentTestRunnerEnabled = this.isCiVisibility && isTrue(DD_CIVISIBILITY_ITR_ENABLED)
    this.isGitUploadEnabled = this.isCiVisibility &&
      (this.isIntelligentTestRunnerEnabled && !isFalse(DD_CIVISIBILITY_GIT_UPLOAD_ENABLED))

    this.gitMetadataEnabled = isTrue(DD_TRACE_GIT_METADATA_ENABLED)

    if (this.gitMetadataEnabled) {
      this.repositoryUrl = coalesce(
        process.env.DD_GIT_REPOSITORY_URL,
        this.tags[GIT_REPOSITORY_URL]
      )
      this.commitSHA = coalesce(
        process.env.DD_GIT_COMMIT_SHA,
        this.tags[GIT_COMMIT_SHA]
      )
      if (!this.repositoryUrl || !this.commitSHA) {
        const DD_GIT_PROPERTIES_FILE = coalesce(
          process.env.DD_GIT_PROPERTIES_FILE,
          `${process.cwd()}/git.properties`
        )
        let gitPropertiesString
        try {
          gitPropertiesString = fs.readFileSync(DD_GIT_PROPERTIES_FILE, 'utf8')
        } catch (e) {
          // Only log error if the user has set a git.properties path
          if (process.env.DD_GIT_PROPERTIES_FILE) {
            log.error(e)
          }
        }
        if (gitPropertiesString) {
          const { commitSHA, repositoryUrl } = getGitMetadataFromGitProperties(gitPropertiesString)
          this.commitSHA = this.commitSHA || commitSHA
          this.repositoryUrl = this.repositoryUrl || repositoryUrl
        }
      }
    }

    this.stats = {
      enabled: isTrue(DD_TRACE_STATS_COMPUTATION_ENABLED)
    }

    this.traceId128BitGenerationEnabled = isTrue(DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED)
    this.traceId128BitLoggingEnabled = isTrue(DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED)

    this.isGCPFunction = isGCPFunction

    tagger.add(this.tags, {
      service: this.service,
      env: this.env,
      version: this.version,
      'runtime-id': uuid()
    })
  }
}

function getAgentUrl (url, options) {
  if (url) return new URL(url)

  if (os.type() === 'Windows_NT') return

  if (
    !options.hostname &&
    !options.port &&
    !process.env.DD_AGENT_HOST &&
    !process.env.DD_TRACE_AGENT_HOSTNAME &&
    !process.env.DD_TRACE_AGENT_PORT &&
    fs.existsSync('/var/run/datadog/apm.socket')
  ) {
    return new URL('unix:///var/run/datadog/apm.socket')
  }
}

module.exports = Config
