'use strict'

const {
  GIT_COMMIT_SHA,
  GIT_REPOSITORY_URL
} = require('../src/plugins/util/tags')
const {
  GRPC_CLIENT_ERROR_STATUSES,
  GRPC_SERVER_ERROR_STATUSES
} = require('../src/constants')

const qsRegex = String.raw`(?:p(?:ass)?w(?:or)?d|pass(?:_?phrase)?|secret|(?:api_?|private_?|public_?|access_?|secret_?)key(?:_?id)?|token|consumer_?(?:id|key|secret)|sign(?:ed|ature)?|auth(?:entication|orization)?)(?:(?:\s|%20)*(?:=|%3D)[^&]+|(?:"|%22)(?:\s|%20)*(?::|%3A)(?:\s|%20)*(?:"|%22)(?:%2[^2]|%[^2]|[^"%])+(?:"|%22))|bearer(?:\s|%20)+[a-z0-9\._\-]+|token(?::|%3A)[a-z0-9]{13}|gh[opsu]_[0-9a-zA-Z]{36}|ey[I-L](?:[\w=-]|%3D)+\.ey[I-L](?:[\w=-]|%3D)+(?:\.(?:[\w.+\/=-]|%3D|%2F|%2B)+)?|[\-]{5}BEGIN(?:[a-z\s]|%20)+PRIVATE(?:\s|%20)KEY[\-]{5}[^\-]+[\-]{5}END(?:[a-z\s]|%20)+PRIVATE(?:\s|%20)KEY|ssh-rsa(?:\s|%20)*(?:[a-z0-9\/\.+]|%2F|%5C|%2B){100,}`
const defaultWafObfuscatorKeyRegex = String.raw`(?i)pass|pw(?:or)?d|secret|(?:api|private|public|access)[_-]?key|token|consumer[_-]?(?:id|key|secret)|sign(?:ed|ature)|bearer|authorization|jsessionid|phpsessid|asp\.net[_-]sessionid|sid|jwt`
const defaultWafObfuscatorValueRegex = String.raw`(?i)(?:p(?:ass)?w(?:or)?d|pass(?:[_-]?phrase)?|secret(?:[_-]?key)?|(?:(?:api|private|public|access)[_-]?)key(?:[_-]?id)?|(?:(?:auth|access|id|refresh)[_-]?)?token|consumer[_-]?(?:id|key|secret)|sign(?:ed|ature)?|auth(?:entication|orization)?|jsessionid|phpsessid|asp\.net(?:[_-]|-)sessionid|sid|jwt)(?:\s*=([^;&]+)|"\s*:\s*("[^"]+"|\d+))|bearer\s+([a-z0-9\._\-]+)|token\s*:\s*([a-z0-9]{13})|gh[opsu]_([0-9a-zA-Z]{36})|ey[I-L][\w=-]+\.(ey[I-L][\w=-]+(?:\.[\w.+\/=-]+)?)|[\-]{5}BEGIN[a-z\s]+PRIVATE\sKEY[\-]{5}([^\-]+)[\-]{5}END[a-z\s]+PRIVATE\sKEY|ssh-rsa\s*([a-z0-9\/\.+]{100,})`

// This file contains a mapping of dd-trace configuration options to their
// corresponding environment variables and default values. This is used in tests
// to report non-default configurations to the test agent.
module.exports = {
  // top-level configs
  apmTracingEnabled: {
    env: 'DD_APM_TRACING_ENABLED',
    defaultValue: true
  },
  'appsec.apiSecurity.enabled': {
    env: 'DD_API_SECURITY_ENABLED',
    defaultValue: true
  },
  'appsec.apiSecurity.sampleDelay': {
    env: 'DD_API_SECURITY_SAMPLE_DELAY',
    defaultValue: 30
  },
  'appsec.blockedTemplateGraphql': {
    env: 'DD_APPSEC_GRAPHQL_BLOCKED_TEMPLATE_JSON',
    defaultValue: undefined
  },
  'appsec.blockedTemplateHtml': {
    env: 'DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML',
    defaultValue: undefined
  },
  'appsec.blockedTemplateJson': {
    env: 'DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON',
    defaultValue: undefined
  },
  'appsec.enabled': {
    env: 'DD_APPSEC_ENABLED',
    defaultValue: undefined
  },
  'appsec.eventTracking.mode': {
    env: 'DD_APPSEC_AUTO_USER_INSTRUMENTATION_MODE',
    defaultValue: 'identification'
  },
  'appsec.extendedHeadersCollection.enabled': {
    env: 'DD_APPSEC_COLLECT_ALL_HEADERS',
    defaultValue: false
  },
  'appsec.extendedHeadersCollection.redaction': {
    env: 'DD_APPSEC_HEADER_COLLECTION_REDACTION_ENABLED',
    defaultValue: true
  },
  'appsec.extendedHeadersCollection.maxHeaders': {
    env: 'DD_APPSEC_MAX_COLLECTED_HEADERS',
    defaultValue: 50
  },
  'appsec.obfuscatorKeyRegex': {
    env: 'DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP',
    defaultValue: defaultWafObfuscatorKeyRegex
  },
  'appsec.obfuscatorValueRegex': {
    env: 'DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP',
    defaultValue: defaultWafObfuscatorValueRegex
  },
  'appsec.rasp.enabled': {
    env: 'DD_APPSEC_RASP_ENABLED',
    defaultValue: true
  },
  'appsec.rasp.bodyCollection': {
    env: 'DD_APPSEC_RASP_COLLECT_REQUEST_BODY',
    defaultValue: false
  },
  'appsec.rateLimit': {
    env: 'DD_APPSEC_TRACE_RATE_LIMIT',
    defaultValue: 100
  },
  'appsec.rules': {
    env: 'DD_APPSEC_RULES',
    defaultValue: undefined
  },
  'appsec.sca.enabled': {
    env: 'DD_APPSEC_SCA_ENABLED',
    defaultValue: null
  },
  'appsec.stackTrace.enabled': {
    env: 'DD_APPSEC_STACK_TRACE_ENABLED',
    defaultValue: true
  },
  'appsec.stackTrace.maxDepth': {
    env: 'DD_APPSEC_MAX_STACK_TRACE_DEPTH',
    defaultValue: 32
  },
  'appsec.stackTrace.maxStackTraces': {
    env: 'DD_APPSEC_MAX_STACK_TRACES',
    defaultValue: 2
  },
  'appsec.wafTimeout': {
    env: 'DD_APPSEC_WAF_TIMEOUT',
    defaultValue: 5e3
  },
  baggageMaxBytes: {
    env: 'DD_TRACE_BAGGAGE_MAX_BYTES',
    defaultValue: 8192
  },
  baggageMaxItems: {
    env: 'DD_TRACE_BAGGAGE_MAX_ITEMS',
    defaultValue: 64
  },
  baggageTagKeys: {
    env: 'DD_TRACE_BAGGAGE_TAG_KEYS',
    defaultValue: 'user.id,session.id,account.id'
  },
  ciVisibilityTestSessionName: {
    env: 'DD_TEST_SESSION_NAME',
    defaultValue: ''
  },
  clientIpEnabled: {
    env: 'DD_TRACE_CLIENT_IP_ENABLED',
    defaultValue: false
  },
  clientIpHeader: {
    env: 'DD_TRACE_CLIENT_IP_HEADER',
    defaultValue: null
  },
  'crashtracking.enabled': {
    env: 'DD_CRASHTRACKING_ENABLED',
    defaultValue: true
  },
  'codeOriginForSpans.enabled': {
    env: 'DD_CODE_ORIGIN_FOR_SPANS_ENABLED',
    defaultValue: true
  },
  'codeOriginForSpans.experimental.exit_spans.enabled': {
    env: 'DD_CODE_ORIGIN_FOR_SPANS_EXPERIMENTAL_EXIT_SPANS_ENABLED',
    defaultValue: false
  },
  dbmPropagationMode: {
    env: 'DD_DBM_PROPAGATION_MODE',
    defaultValue: 'disabled'
  },
  'dogstatsd.hostname': {
    env: 'DD_DOGSTATSD_HOST',
    defaultValue: '127.0.0.1'
  },
  'dogstatsd.port': {
    env: 'DD_DOGSTATSD_PORT',
    defaultValue: '8125'
  },
  dsmEnabled: {
    env: 'DD_DATA_STREAMS_ENABLED',
    defaultValue: false
  },
  'dynamicInstrumentation.enabled': {
    env: 'DD_DYNAMIC_INSTRUMENTATION_ENABLED',
    defaultValue: false
  },
  'dynamicInstrumentation.probeFile': {
    env: 'DD_DYNAMIC_INSTRUMENTATION_PROBE_FILE',
    defaultValue: undefined
  },
  'dynamicInstrumentation.redactedIdentifiers': {
    env: 'DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS',
    defaultValue: []
  },
  'dynamicInstrumentation.redactionExcludedIdentifiers': {
    env: 'DD_DYNAMIC_INSTRUMENTATION_REDACTION_EXCLUDED_IDENTIFIERS',
    defaultValue: []
  },
  'dynamicInstrumentation.uploadIntervalSeconds': {
    env: 'DD_DYNAMIC_INSTRUMENTATION_UPLOAD_INTERVAL_SECONDS',
    defaultValue: 1
  },
  env: {
    env: 'DD_ENV',
    defaultValue: undefined
  },
  'experimental.enableGetRumData': {
    env: 'DD_TRACE_EXPERIMENTAL_GET_RUM_DATA_ENABLED',
    defaultValue: false
  },
  'experimental.exporter': {
    env: 'DD_TRACE_EXPERIMENTAL_EXPORTER',
    defaultValue: undefined
  },
  flushInterval: {
    env: null,
    defaultValue: 2000
  },
  flushMinSpans: {
    env: 'DD_TRACE_PARTIAL_FLUSH_MIN_SPANS',
    defaultValue: 1000
  },
  gitMetadataEnabled: {
    env: 'DD_TRACE_GIT_METADATA_ENABLED',
    defaultValue: true
  },
  graphqlErrorExtensions: {
    env: 'DD_TRACE_GRAPHQL_ERROR_EXTENSIONS',
    defaultValue: []
  },
  'grpc.client.error.statuses': {
    env: 'DD_GRPC_CLIENT_ERROR_STATUSES',
    defaultValue: GRPC_CLIENT_ERROR_STATUSES
  },
  'grpc.server.error.statuses': {
    env: 'DD_GRPC_SERVER_ERROR_STATUSES',
    defaultValue: GRPC_SERVER_ERROR_STATUSES
  },
  headerTags: {
    env: 'DD_TRACE_HEADER_TAGS',
    defaultValue: []
  },
  'heapSnapshot.count': {
    env: 'DD_HEAP_SNAPSHOT_COUNT',
    defaultValue: 0
  },
  'heapSnapshot.destination': {
    env: 'DD_HEAP_SNAPSHOT_DESTINATION',
    defaultValue: ''
  },
  'heapSnapshot.interval': {
    env: 'DD_HEAP_SNAPSHOT_INTERVAL',
    defaultValue: 3600
  },
  hostname: {
    env: 'DD_AGENT_HOST',
    defaultValue: '127.0.0.1'
  },
  'iast.dbRowsToTaint': {
    env: 'DD_IAST_DB_ROWS_TO_TAINT',
    defaultValue: 1
  },
  'iast.deduplicationEnabled': {
    env: 'DD_IAST_DEDUPLICATION_ENABLED',
    defaultValue: true
  },
  'iast.enabled': {
    env: 'DD_IAST_ENABLED',
    defaultValue: false
  },
  'iast.maxConcurrentRequests': {
    env: 'DD_IAST_MAX_CONCURRENT_REQUESTS',
    defaultValue: 2
  },
  'iast.maxContextOperations': {
    env: 'DD_IAST_MAX_CONTEXT_OPERATIONS',
    defaultValue: 2
  },
  'iast.redactionEnabled': {
    env: 'DD_IAST_REDACTION_ENABLED',
    defaultValue: true
  },
  'iast.redactionNamePattern': {
    env: 'DD_IAST_REDACTION_NAME_PATTERN',
    defaultValue: null
  },
  'iast.redactionValuePattern': {
    env: 'DD_IAST_REDACTION_VALUE_PATTERN',
    defaultValue: null
  },
  'iast.requestSampling': {
    env: 'DD_IAST_REQUEST_SAMPLING',
    defaultValue: 30
  },
  'iast.securityControlsConfiguration': {
    env: 'DD_IAST_SECURITY_CONTROLS_CONFIGURATION',
    defaultValue: null
  },
  'iast.telemetryVerbosity': {
    env: 'DD_IAST_TELEMETRY_VERBOSITY',
    defaultValue: 'INFORMATION'
  },
  'iast.stackTrace.enabled': {
    env: 'DD_IAST_STACK_TRACE_ENABLED',
    defaultValue: true
  },
  injectionEnabled: {
    env: 'DD_INJECTION_ENABLED',
    defaultValue: []
  },
  instrumentationSource: {
    env: null,
    defaultValue: 'manual'
  },
  injectForce: {
    env: 'DD_INJECT_FORCE',
    defaultValue: null
  },
  isAzureFunction: {
    env: null,
    defaultValue: false
  },
  isCiVisibility: {
    env: null,
    defaultValue: false
  },
  isEarlyFlakeDetectionEnabled: {
    env: 'DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED',
    defaultValue: false
  },
  isFlakyTestRetriesEnabled: {
    env: 'DD_CIVISIBILITY_FLAKY_RETRY_ENABLED',
    defaultValue: false
  },
  flakyTestRetriesCount: {
    env: 'DD_CIVISIBILITY_FLAKY_RETRY_COUNT',
    defaultValue: 5
  },
  isGCPFunction: {
    env: null,
    defaultValue: false
  },
  isGitUploadEnabled: {
    env: 'DD_CIVISIBILITY_GIT_UPLOAD_ENABLED',
    defaultValue: false
  },
  isIntelligentTestRunnerEnabled: {
    env: 'DD_CIVISIBILITY_ITR_ENABLED',
    defaultValue: false
  },
  isManualApiEnabled: {
    env: 'DD_CIVISIBILITY_MANUAL_API_ENABLED',
    defaultValue: false
  },
  'langchain.spanCharLimit': {
    env: 'DD_LANGCHAIN_SPAN_CHAR_LIMIT',
    defaultValue: 128
  },
  'langchain.spanPromptCompletionSampleRate': {
    env: 'DD_LANGCHAIN_SPAN_PROMPT_COMPLETION_SAMPLE_RATE',
    defaultValue: 1
  },
  'llmobs.agentlessEnabled': {
    env: 'DD_LLMOBS_AGENTLESS_ENABLED',
    defaultValue: undefined
  },
  'llmobs.enabled': {
    env: 'DD_LLMOBS_ENABLED',
    defaultValue: false
  },
  'llmobs.mlApp': {
    env: 'DD_LLMOBS_ML_APP',
    defaultValue: undefined
  },
  ciVisAgentlessLogSubmissionEnabled: {
    env: 'DD_AGENTLESS_LOG_SUBMISSION_ENABLED',
    defaultValue: false
  },
  legacyBaggageEnabled: {
    env: 'DD_TRACE_LEGACY_BAGGAGE_ENABLED',
    defaultValue: true
  },
  isTestDynamicInstrumentationEnabled: {
    env: 'DD_TEST_FAILED_TEST_REPLAY_ENABLED',
    defaultValue: false
  },
  isServiceUserProvided: {
    env: null,
    defaultValue: false
  },
  testManagementAttemptToFixRetries: {
    env: 'DD_TEST_MANAGEMENT_ATTEMPT_TO_FIX_RETRIES',
    defaultValue: 20
  },
  isTestManagementEnabled: {
    env: 'DD_TEST_MANAGEMENT_ENABLED',
    defaultValue: false
  },
  isImpactedTestsEnabled: {
    env: 'DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED',
    defaultValue: false
  },
  logInjection: {
    env: 'DD_LOGS_INJECTION',
    defaultValue: true
  },
  lookup: {
    env: null,
    defaultValue: undefined
  },
  inferredProxyServicesEnabled: {
    env: 'DD_TRACE_INFERRED_PROXY_SERVICES_ENABLED',
    defaultValue: false
  },
  memcachedCommandEnabled: {
    env: 'DD_TRACE_MEMCACHED_COMMAND_ENABLED',
    defaultValue: false
  },
  middlewareTracingEnabled: {
    env: 'DD_TRACE_MIDDLEWARE_TRACING_ENABLED',
    defaultValue: true
  },
  openAiLogsEnabled: {
    env: 'DD_OPENAI_LOGS_ENABLED',
    defaultValue: false
  },
  'openai.spanCharLimit': {
    env: 'DD_OPENAI_SPAN_CHAR_LIMIT',
    defaultValue: 128
  },
  peerServiceMapping: {
    env: 'DD_TRACE_PEER_SERVICE_MAPPING',
    defaultValue: {}
  },
  plugins: {
    env: null,
    defaultValue: true
  },
  port: {
    env: 'DD_TRACE_AGENT_PORT',
    defaultValue: '8126'
  },
  'profiling.enabled': {
    env: 'DD_PROFILING_ENABLED',
    defaultValue: undefined
  },
  'profiling.exporters': {
    env: 'DD_PROFILING_EXPORTERS',
    defaultValue: 'agent'
  },
  'profiling.sourceMap': {
    env: 'DD_PROFILING_SOURCE_MAP',
    defaultValue: true
  },
  'profiling.longLivedThreshold': {
    env: 'DD_INTERNAL_PROFILING_LONG_LIVED_THRESHOLD',
    defaultValue: undefined
  },
  protocolVersion: {
    env: 'DD_TRACE_AGENT_PROTOCOL_VERSION',
    defaultValue: '0.4'
  },
  queryStringObfuscation: {
    env: 'DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP',
    defaultValue: qsRegex
  },
  'remoteConfig.enabled': {
    env: 'DD_REMOTE_CONFIGURATION_ENABLED',
    defaultValue: true
  },
  'remoteConfig.pollInterval': {
    env: 'DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS',
    defaultValue: 5
  },
  reportHostname: {
    env: 'DD_TRACE_REPORT_HOSTNAME',
    defaultValue: false
  },
  'runtimeMetrics.enabled': {
    env: 'DD_RUNTIME_METRICS_ENABLED',
    defaultValue: false
  },
  'runtimeMetrics.eventLoop': {
    env: 'DD_RUNTIME_METRICS_EVENT_LOOP_ENABLED',
    defaultValue: true
  },
  'runtimeMetrics.gc': {
    env: 'DD_RUNTIME_METRICS_GC_ENABLED',
    defaultValue: true
  },
  runtimeMetricsRuntimeId: {
    env: 'DD_RUNTIME_METRICS_RUNTIME_ID_ENABLED',
    defaultValue: false
  },
  sampleRate: {
    env: 'DD_TRACE_SAMPLE_RATE',
    defaultValue: undefined
  },
  'sampler.rateLimit': {
    env: 'DD_TRACE_RATE_LIMIT',
    defaultValue: 100
  },
  'sampler.rules': {
    env: 'DD_TRACE_SAMPLING_RULES',
    defaultValue: []
  },
  'sampler.spanSamplingRules': {
    env: 'DD_SPAN_SAMPLING_RULES',
    defaultValue: []
  },
  scope: {
    env: 'DD_TRACE_SCOPE',
    defaultValue: undefined
  },
  service: {
    env: 'DD_SERVICE',
    defaultValue: 'node'
  },
  serviceMapping: {
    env: 'DD_SERVICE_MAPPING',
    defaultValue: {}
  },
  site: {
    env: 'DD_SITE',
    defaultValue: 'datadoghq.com'
  },
  spanAttributeSchema: {
    env: 'DD_TRACE_SPAN_ATTRIBUTE_SCHEMA',
    defaultValue: 'v0'
  },
  spanComputePeerService: {
    env: 'DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED',
    defaultValue: false
  },
  spanLeakDebug: {
    env: 'DD_TRACE_SPAN_LEAK_DEBUG',
    defaultValue: 0
  },
  spanRemoveIntegrationFromService: {
    env: 'DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED',
    defaultValue: false
  },
  startupLogs: {
    env: 'DD_TRACE_STARTUP_LOGS',
    defaultValue: false
  },
  'stats.enabled': {
    env: 'DD_TRACE_STATS_COMPUTATION_ENABLED',
    defaultValue: false
  },
  tags: {
    env: 'DD_TAGS',
    defaultValue: {}
  },
  tagsHeaderMaxLength: {
    env: 'DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH',
    defaultValue: 512
  },
  'telemetry.debug': {
    env: 'DD_TELEMETRY_DEBUG',
    defaultValue: false
  },
  'telemetry.dependencyCollection': {
    env: 'DD_TELEMETRY_DEPENDENCY_COLLECTION_ENABLED',
    defaultValue: true
  },
  'telemetry.enabled': {
    env: 'DD_INSTRUMENTATION_TELEMETRY_ENABLED',
    defaultValue: true
  },
  'telemetry.heartbeatInterval': {
    env: 'DD_TELEMETRY_HEARTBEAT_INTERVAL',
    defaultValue: 60000
  },
  'telemetry.logCollection': {
    env: 'DD_TELEMETRY_LOG_COLLECTION_ENABLED',
    defaultValue: true
  },
  'telemetry.metrics': {
    env: 'DD_TELEMETRY_METRICS_ENABLED',
    defaultValue: true
  },
  traceEnabled: {
    env: 'DD_TRACE_ENABLED',
    defaultValue: true
  },
  traceId128BitGenerationEnabled: {
    env: 'DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED',
    defaultValue: true
  },
  traceId128BitLoggingEnabled: {
    env: 'DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED',
    defaultValue: true
  },
  tracePropagationExtractFirst: {
    env: 'DD_TRACE_PROPAGATION_EXTRACT_FIRST',
    defaultValue: false
  },
  tracePropagationBehaviorExtract: {
    env: 'DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT',
    defaultValue: 'continue'
  },
  'tracePropagationStyle.inject': {
    env: 'DD_TRACE_PROPAGATION_STYLE_INJECT',
    defaultValue: ['datadog', 'tracecontext', 'baggage']
  },
  'tracePropagationStyle.extract': {
    env: 'DD_TRACE_PROPAGATION_STYLE_EXTRACT',
    defaultValue: ['datadog', 'tracecontext', 'baggage']
  },
  'tracePropagationStyle.otelPropagators': {
    env: 'OTEL_PROPAGATORS',
    defaultValue: false
  },
  tracing: {
    env: 'DD_TRACING_ENABLED',
    defaultValue: true
  },
  url: {
    env: 'DD_TRACE_AGENT_URL',
    defaultValue: undefined
  },
  version: {
    env: 'DD_VERSION',
    defaultValue: require('../../../package.json').version
  },
  instrumentation_config_id: {
    env: 'DD_INSTRUMENTATION_CONFIG_ID',
    defaultValue: undefined
  },
  'vertexai.spanCharLimit': {
    env: 'DD_VERTEXAI_SPAN_CHAR_LIMIT',
    defaultValue: 128
  },
  'vertexai.spanPromptCompletionSampleRate': {
    env: 'DD_VERTEXAI_SPAN_PROMPT_COMPLETION_SAMPLE_RATE',
    defaultValue: 1
  },
  'trace.aws.addSpanPointers': {
    env: 'DD_TRACE_AWS_ADD_SPAN_POINTERS',
    defaultValue: true
  },
  'trace.dynamoDb.tablePrimaryKeys': {
    env: 'DD_TRACE_DYNAMODB_TABLE_PRIMARY_KEYS',
    defaultValue: undefined
  },
  'trace.nativeSpanEvents': {
    env: 'DD_TRACE_NATIVE_SPAN_EVENTS',
    defaultValue: false
  },
  [GIT_REPOSITORY_URL]: {
    env: 'DD_GIT_REPOSITORY_URL'
  },
  [GIT_COMMIT_SHA]: {
    env: 'DD_GIT_COMMIT_SHA'
  }
}
