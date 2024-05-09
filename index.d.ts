import { ClientRequest, IncomingMessage, OutgoingMessage, ServerResponse } from "http";
import { LookupFunction } from 'net';
import * as opentracing from "opentracing";
import * as otel from "@opentelemetry/api";

/**
 * Tracer is the entry-point of the Datadog tracing implementation.
 */
interface Tracer extends opentracing.Tracer {
  /**
   * Add tracer as a named export
   */
  tracer: Tracer;

  /**
   * For compatibility with NodeNext + esModuleInterop: false
   */
  default: Tracer;

  /**
   * Starts and returns a new Span representing a logical unit of work.
   * @param {string} name The name of the operation.
   * @param {tracer.SpanOptions} [options] Options for the newly created span.
   * @returns {Span} A new Span object.
   */
  startSpan (name: string, options?: tracer.SpanOptions): tracer.Span;

  /**
   * Injects the given SpanContext instance for cross-process propagation
   * within `carrier`
   * @param  {SpanContext} spanContext The SpanContext to inject into the
   *         carrier object. As a convenience, a Span instance may be passed
   *         in instead (in which case its .context() is used for the
   *         inject()).
   * @param  {string} format The format of the carrier.
   * @param  {any} carrier The carrier object.
   */
  inject (spanContext: tracer.SpanContext | tracer.Span, format: string, carrier: any): void;

  /**
   * Returns a SpanContext instance extracted from `carrier` in the given
   * `format`.
   * @param  {string} format The format of the carrier.
   * @param  {any} carrier The carrier object.
   * @return {SpanContext}
   *         The extracted SpanContext, or null if no such SpanContext could
   *         be found in `carrier`
   */
  extract (format: string, carrier: any): tracer.SpanContext | null;

  /**
   * Initializes the tracer. This should be called before importing other libraries.
   */
  init (options?: tracer.TracerOptions): this;

  /**
   * Sets the URL for the trace agent. This should only be called _after_
   * init() is called, only in cases where the URL needs to be set after
   * initialization.
   */
  setUrl (url: string): this;

  /**
   * Enable and optionally configure a plugin.
   * @param plugin The name of a built-in plugin.
   * @param config Configuration options. Can also be `false` to disable the plugin.
   */
  use<P extends keyof Plugins> (plugin: P, config?: Plugins[P] | boolean): this;

  /**
   * Returns a reference to the current scope.
   */
  scope (): tracer.Scope;

  /**
   * Instruments a function by automatically creating a span activated on its
   * scope.
   *
   * The span will automatically be finished when one of these conditions is
   * met:
   *
   * * The function returns a promise, in which case the span will finish when
   * the promise is resolved or rejected.
   * * The function takes a callback as its second parameter, in which case the
   * span will finish when that callback is called.
   * * The function doesn't accept a callback and doesn't return a promise, in
   * which case the span will finish at the end of the function execution.
   *
   * If the `orphanable` option is set to false, the function will not be traced
   * unless there is already an active span or `childOf` option. Note that this
   * option is deprecated and has been removed in version 4.0.
   */
  trace<T> (name: string, fn: (span: tracer.Span) => T): T;
  trace<T> (name: string, fn: (span: tracer.Span, done: (error?: Error) => void) => T): T;
  trace<T> (name: string, options: tracer.TraceOptions & tracer.SpanOptions, fn: (span?: tracer.Span, done?: (error?: Error) => void) => T): T;

  /**
   * Wrap a function to automatically create a span activated on its
   * scope when it's called.
   *
   * The span will automatically be finished when one of these conditions is
   * met:
   *
   * * The function returns a promise, in which case the span will finish when
   * the promise is resolved or rejected.
   * * The function takes a callback as its last parameter, in which case the
   * span will finish when that callback is called.
   * * The function doesn't accept a callback and doesn't return a promise, in
   * which case the span will finish at the end of the function execution.
   */
  wrap<T = (...args: any[]) => any> (name: string, fn: T): T;
  wrap<T = (...args: any[]) => any> (name: string, options: tracer.TraceOptions & tracer.SpanOptions, fn: T): T;
  wrap<T = (...args: any[]) => any> (name: string, options: (...args: any[]) => tracer.TraceOptions & tracer.SpanOptions, fn: T): T;

  /**
   * Returns an HTML string containing <meta> tags that should be included in
   * the <head> of a document to enable correlating the current trace with the
   * RUM view. Otherwise, it is not possible to associate the trace used to
   * generate the initial HTML document with a given RUM view. The resulting
   * HTML document should not be cached as the meta tags are time-sensitive
   * and are associated with a specific user.
   *
   * Note that this feature is currently not supported by the backend and
   * using it will have no effect.
   */
  getRumData (): string;

  /**
   * Links an authenticated user to the current trace.
   * @param {User} user Properties of the authenticated user. Accepts custom fields.
   * @returns {Tracer} The Tracer instance for chaining.
   */
  setUser (user: tracer.User): Tracer;

  appsec: tracer.Appsec;

  TracerProvider: tracer.opentelemetry.TracerProvider;

  dogstatsd: tracer.DogStatsD;
}

// left out of the namespace, so it
// is doesn't need to be exported for Tracer
/** @hidden */
interface Plugins {
  "aerospike": tracer.plugins.aerospike;
  "amqp10": tracer.plugins.amqp10;
  "amqplib": tracer.plugins.amqplib;
  "apollo": tracer.plugins.apollo;
  "aws-sdk": tracer.plugins.aws_sdk;
  "bunyan": tracer.plugins.bunyan;
  "cassandra-driver": tracer.plugins.cassandra_driver;
  "child_process": tracer.plugins.child_process;
  "connect": tracer.plugins.connect;
  "couchbase": tracer.plugins.couchbase;
  "cucumber": tracer.plugins.cucumber;
  "cypress": tracer.plugins.cypress;
  "dns": tracer.plugins.dns;
  "elasticsearch": tracer.plugins.elasticsearch;
  "express": tracer.plugins.express;
  "fastify": tracer.plugins.fastify;
  "fetch": tracer.plugins.fetch;
  "generic-pool": tracer.plugins.generic_pool;
  "google-cloud-pubsub": tracer.plugins.google_cloud_pubsub;
  "graphql": tracer.plugins.graphql;
  "grpc": tracer.plugins.grpc;
  "hapi": tracer.plugins.hapi;
  "http": tracer.plugins.http;
  "http2": tracer.plugins.http2;
  "ioredis": tracer.plugins.ioredis;
  "jest": tracer.plugins.jest;
  "kafkajs": tracer.plugins.kafkajs
  "knex": tracer.plugins.knex;
  "koa": tracer.plugins.koa;
  "mariadb": tracer.plugins.mariadb;
  "memcached": tracer.plugins.memcached;
  "microgateway-core": tracer.plugins.microgateway_core;
  "mocha": tracer.plugins.mocha;
  "moleculer": tracer.plugins.moleculer;
  "mongodb-core": tracer.plugins.mongodb_core;
  "mongoose": tracer.plugins.mongoose;
  "mysql": tracer.plugins.mysql;
  "mysql2": tracer.plugins.mysql2;
  "net": tracer.plugins.net;
  "next": tracer.plugins.next;
  "openai": tracer.plugins.openai;
  "opensearch": tracer.plugins.opensearch;
  "oracledb": tracer.plugins.oracledb;
  "paperplane": tracer.plugins.paperplane;
  "playwright": tracer.plugins.playwright;
  "pg": tracer.plugins.pg;
  "pino": tracer.plugins.pino;
  "redis": tracer.plugins.redis;
  "restify": tracer.plugins.restify;
  "rhea": tracer.plugins.rhea;
  "router": tracer.plugins.router;
  "selenium": tracer.plugins.selenium;
  "sharedb": tracer.plugins.sharedb;
  "tedious": tracer.plugins.tedious;
  "undici": tracer.plugins.undici;
  "winston": tracer.plugins.winston;
}

declare namespace tracer {
  export type SpanOptions = opentracing.SpanOptions;
  export { Tracer };

  export interface TraceOptions extends Analyzable {
    /**
     * The resource you are tracing. The resource name must not be longer than
     * 5000 characters.
     */
    resource?: string,

    /**
     * The service you are tracing. The service name must not be longer than
     * 100 characters.
     */
    service?: string,

    /**
     * The type of request.
     */
    type?: string

    /**
     * An array of span links
     */
    links?: Array<{ context: SpanContext, attributes?: Object }>
  }

  /**
   * Span represents a logical unit of work as part of a broader Trace.
   * Examples of span might include remote procedure calls or a in-process
   * function calls to sub-components. A Trace has a single, top-level "root"
   * Span that in turn may have zero or more child Spans, which in turn may
   * have children.
   */
  export interface Span extends opentracing.Span {
    context (): SpanContext;

    /**
     * Causally links another span to the current span
     * @param {SpanContext} context The context of the span to link to.
     * @param {Object} attributes An optional key value pair of arbitrary values.
     * @returns {void}
     */
    addLink (context: SpanContext, attributes?: Object): void;
  }

  /**
   * SpanContext represents Span state that must propagate to descendant Spans
   * and across process boundaries.
   *
   * SpanContext is logically divided into two pieces: the user-level "Baggage"
   * (see setBaggageItem and getBaggageItem) that propagates across Span
   * boundaries and any Tracer-implementation-specific fields that are needed to
   * identify or otherwise contextualize the associated Span instance (e.g., a
   * <trace_id, span_id, sampled> tuple).
   */
  export interface SpanContext extends opentracing.SpanContext {
    /**
     * Returns the string representation of the internal trace ID.
     */
    toTraceId (): string;

    /**
     * Returns the string representation of the internal span ID.
     */
    toSpanId (): string;

    /**
     * Returns the string representation used for DBM integration.
     */
    toTraceparent (): string;
  }

  /**
   * Sampling rule to configure on the priority sampler.
   */
  export interface SamplingRule {
    /**
     * Sampling rate for this rule.
     */
    sampleRate: number

    /**
     * Service on which to apply this rule. The rule will apply to all services if not provided.
     */
    service?: string | RegExp

    /**
     * Operation name on which to apply this rule. The rule will apply to all operation names if not provided.
     */
    name?: string | RegExp
  }

  /**
   * Span sampling rules to ingest single spans where the enclosing trace is dropped
   */
  export interface SpanSamplingRule {
    /**
     * Sampling rate for this rule. Will default to 1.0 (always) if not provided.
     */
    sampleRate?: number

    /**
     * Maximum number of spans matching a span sampling rule to be allowed per second.
     */
    maxPerSecond?: number

    /**
     * Service name or pattern on which to apply this rule. The rule will apply to all services if not provided.
     */
    service?: string

    /**
     * Operation name or pattern on which to apply this rule. The rule will apply to all operation names if not provided.
     */
    name?: string
  }

  /**
   * Selection and priority order of context propagation injection and extraction mechanisms.
   */
  export interface PropagationStyle {
    /**
     * Selection of context propagation injection mechanisms.
     */
    inject: string[],

    /**
     * Selection and priority order of context propagation extraction mechanisms.
     */
    extract: string[]
  }

  /**
   * List of options available to the tracer.
   */
  export interface TracerOptions {
    /**
     * Whether to enable trace ID injection in log records to be able to correlate
     * traces with logs.
     * @default false
     */
    logInjection?: boolean,

    /**
     * Whether to enable startup logs.
     * @default true
     */
    startupLogs?: boolean,

    /**
     * The service name to be used for this program. If not set, the service name
     * will attempted to be inferred from package.json
     */
    service?: string;

    /**
     * Provide service name mappings for each plugin.
     */
    serviceMapping?: { [key: string]: string };

    /**
     * The url of the trace agent that the tracer will submit to.
     * Takes priority over hostname and port, if set.
     */
    url?: string;

    /**
     * The address of the trace agent that the tracer will submit to.
     * @default 'localhost'
     */
    hostname?: string;

    /**
     * The port of the trace agent that the tracer will submit to.
     * @default 8126
     */
    port?: number | string;

    /**
     * Whether to enable profiling.
     */
    profiling?: boolean

    /**
     * Options specific for the Dogstatsd agent.
     */
    dogstatsd?: {
      /**
       * The hostname of the Dogstatsd agent that the metrics will submitted to.
       */
      hostname?: string

      /**
       * The port of the Dogstatsd agent that the metrics will submitted to.
       * @default 8125
       */
      port?: number
    };

    /**
     * Set an application’s environment e.g. prod, pre-prod, stage.
     */
    env?: string;

    /**
     * The version number of the application. If not set, the version
     * will attempted to be inferred from package.json.
     */
    version?: string;

    /**
     * Controls the ingestion sample rate (between 0 and 1) between the agent and the backend.
     */
    sampleRate?: number;

    /**
     * Global rate limit that is applied on the global sample rate and all rules,
     * and controls the ingestion rate limit between the agent and the backend.
     * Defaults to deferring the decision to the agent.
     */
    rateLimit?: number,

    /**
     * Sampling rules to apply to priority samplin. Each rule is a JSON,
     * consisting of `service` and `name`, which are regexes to match against
     * a trace's `service` and `name`, and a corresponding `sampleRate`. If not
     * specified, will defer to global sampling rate for all spans.
     * @default []
     */
    samplingRules?: SamplingRule[]

    /**
     * Span sampling rules that take effect when the enclosing trace is dropped, to ingest single spans
     * @default []
     */
    spanSamplingRules?: SpanSamplingRule[]

    /**
     * Interval in milliseconds at which the tracer will submit traces to the agent.
     * @default 2000
     */
    flushInterval?: number;

    /**
     *  Number of spans before partially exporting a trace. This prevents keeping all the spans in memory for very large traces.
     * @default 1000
     */
    flushMinSpans?: number;

    /**
     * Whether to enable runtime metrics.
     * @default false
     */
    runtimeMetrics?: boolean

    /**
     * Custom function for DNS lookups when sending requests to the agent.
     * @default dns.lookup()
     */
    lookup?: LookupFunction

    /**
     * Protocol version to use for requests to the agent. The version configured must be supported by the agent version installed or all traces will be dropped.
     * @default 0.4
     */
    protocolVersion?: string

    /**
     * Deprecated in favor of the global versions of the variables provided under this option
     *
     * @deprecated
     * @hidden
     */
    ingestion?: {
      /**
       * Controls the ingestion sample rate (between 0 and 1) between the agent and the backend.
       */
      sampleRate?: number

      /**
       * Controls the ingestion rate limit between the agent and the backend. Defaults to deferring the decision to the agent.
       */
      rateLimit?: number
    };

    /**
     * Experimental features can be enabled individually using key / value pairs.
     * @default {}
     */
    experimental?: {
      b3?: boolean
      traceparent?: boolean

      /**
       * Whether to add an auto-generated `runtime-id` tag to metrics.
       * @default false
       */
      runtimeId?: boolean

      /**
       * Whether to write traces to log output or agentless, rather than send to an agent
       * @default false
       */
      exporter?: 'log' | 'agent' | 'datadog'

      /**
       * Whether to enable the experimental `getRumData` method.
       * @default false
       */
      enableGetRumData?: boolean

      /**
       * Configuration of the IAST. Can be a boolean as an alias to `iast.enabled`.
       */
      iast?: boolean | {
        /**
         * Whether to enable IAST.
         * @default false
         */
        enabled?: boolean,
        /**
         * Controls the percentage of requests that iast will analyze
         * @default 30
         */
        requestSampling?: number,
        /**
         * Controls how many request can be analyzing code vulnerabilities at the same time
         * @default 2
         */
        maxConcurrentRequests?: number,
        /**
         * Controls how many code vulnerabilities can be detected in the same request
         * @default 2
         */
        maxContextOperations?: number,
        /**
         * Whether to enable vulnerability deduplication
         */
        deduplicationEnabled?: boolean,
        /**
         * Whether to enable vulnerability redaction
         * @default true
         */
        redactionEnabled?: boolean,
        /**
         * Specifies a regex that will redact sensitive source names in vulnerability reports.
         */
        redactionNamePattern?: string,
        /**
         * Specifies a regex that will redact sensitive source values in vulnerability reports.
         */
        redactionValuePattern?: string
      }
    };

    /**
     * Whether to load all built-in plugins.
     * @default true
     */
    plugins?: boolean;

    /**
     * Custom logger to be used by the tracer (if debug = true),
     * should support error(), warn(), info(), and debug() methods
     * see https://datadog.github.io/dd-trace-js/#custom-logging
     */
    logger?: {
      error: (err: Error | string) => void;
      warn: (message: string) => void;
      info: (message: string) => void;
      debug: (message: string) => void;
    };

    /**
     * Global tags that should be assigned to every span.
     */
    tags?: { [key: string]: any };

    /**
     * Specifies which scope implementation to use. The default is to use the best
     * implementation for the runtime. Only change this if you know what you are
     * doing.
     */
    scope?: 'async_hooks' | 'async_local_storage' | 'async_resource' | 'sync' | 'noop'

    /**
     * Whether to report the hostname of the service host. This is used when the agent is deployed on a different host and cannot determine the hostname automatically.
     * @default false
     */
    reportHostname?: boolean

    /**
     * A string representing the minimum tracer log level to use when debug logging is enabled
     * @default 'debug'
     */
    logLevel?: 'error' | 'debug'

    /**
     * If false, require a parent in order to trace.
     * @default true
     * @deprecated since version 4.0
     */
    orphanable?: boolean

    /**
     * Enables DBM to APM link using tag injection.
     * @default 'disabled'
     */
    dbmPropagationMode?: 'disabled' | 'service' | 'full'

    /**
     * Configuration of the AppSec protection. Can be a boolean as an alias to `appsec.enabled`.
     */
    appsec?: boolean | {
      /**
       * Whether to enable AppSec.
       * @default false
       */
      enabled?: boolean,

      /**
       * Specifies a path to a custom rules file.
       */
      rules?: string,

      /**
       * Controls the maximum amount of traces sampled by AppSec attacks, per second.
       * @default 100
       */
      rateLimit?: number,

      /**
       * Controls the maximum amount of time in microseconds the WAF is allowed to run synchronously for.
       * @default 5000
       */
      wafTimeout?: number,

      /**
       * Specifies a regex that will redact sensitive data by its key in attack reports.
       */
      obfuscatorKeyRegex?: string,

      /**
       * Specifies a regex that will redact sensitive data by its value in attack reports.
       */
      obfuscatorValueRegex?: string,

      /**
       * Specifies a path to a custom blocking template html file.
       */
      blockedTemplateHtml?: string,

      /**
       * Specifies a path to a custom blocking template json file.
       */
      blockedTemplateJson?: string,

      /**
       * Specifies a path to a custom blocking template json file for graphql requests
       */
      blockedTemplateGraphql?: string,

      /**
       * Controls the automated user event tracking configuration
       */
      eventTracking?: {
        /**
         * Controls the automated user event tracking mode. Possible values are disabled, safe and extended.
         * On safe mode, any detected Personally Identifiable Information (PII) about the user will be redacted from the event.
         * On extended mode, no redaction will take place.
         * @default 'safe'
         */
        mode?: 'safe' | 'extended' | 'disabled'
      },
      /**
       * Configuration for Api Security sampling
       */
      apiSecurity?: {
        /** Whether to enable Api Security.
         * @default false
         */
        enabled?: boolean,

        /** Controls the request sampling rate (between 0 and 1) in which Api Security is triggered.
         * The value will be coerced back if it's outside of the 0-1 range.
         * @default 0.1
         */
        requestSampling?: number
      },
      /**
       * Configuration for RASP
       */
      rasp?: {
        /** Whether to enable RASP.
         * @default false
         */
        enabled?: boolean
      }
    };

    /**
     * Configuration of ASM Remote Configuration
     */
    remoteConfig?: {
      /**
       * Specifies the remote configuration polling interval in seconds
       * @default 5
       */
      pollInterval?: number,
    }

    /**
     * Whether to enable client IP collection from relevant IP headers
     * @default false
     */
    clientIpEnabled?: boolean

    /**
     * Custom header name to source the http.client_ip tag from.
     */
    clientIpHeader?: string,

    /**
     * The selection and priority order of context propagation injection and extraction mechanisms.
     */
    propagationStyle?: string[] | PropagationStyle
  }

  /**
   * User object that can be passed to `tracer.setUser()`.
   */
  export interface User {
    /**
     * Unique identifier of the user.
     * Mandatory.
     */
    id: string,

    /**
     * Email of the user.
     */
    email?: string,

    /**
     * User-friendly name of the user.
     */
    name?: string,

    /**
     * Session ID of the user.
     */
    session_id?: string,

    /**
     * Role the user is making the request under.
     */
    role?: string,

    /**
     * Scopes or granted authorizations the user currently possesses.
     * The value could come from the scope associated with an OAuth2
     * Access Token or an attribute value in a SAML 2 Assertion.
     */
    scope?: string,

    /**
     * Custom fields to attach to the user (RBAC, Oauth, etc…).
     */
    [key: string]: string | undefined
  }

  export interface DogStatsD {
    /**
     * Increments a metric by the specified value, optionally specifying tags.
     * @param {string} stat The dot-separated metric name.
     * @param {number} value The amount to increment the stat by.
     * @param {[tag:string]:string|number} tags Tags to pass along, such as `{ foo: 'bar' }`. Values are combined with config.tags.
     */
    increment(stat: string, value?: number, tags?: { [tag: string]: string|number }): void

    /**
     * Decrements a metric by the specified value, optionally specifying tags.
     * @param {string} stat The dot-separated metric name.
     * @param {number} value The amount to decrement the stat by.
     * @param {[tag:string]:string|number} tags Tags to pass along, such as `{ foo: 'bar' }`. Values are combined with config.tags.
     */
    decrement(stat: string, value?: number, tags?: { [tag: string]: string|number }): void

    /**
     * Sets a distribution value, optionally specifying tags.
     * @param {string} stat The dot-separated metric name.
     * @param {number} value The amount to increment the stat by.
     * @param {[tag:string]:string|number} tags Tags to pass along, such as `{ foo: 'bar' }`. Values are combined with config.tags.
     */
    distribution(stat: string, value?: number, tags?: { [tag: string]: string|number }): void

    /**
     * Sets a gauge value, optionally specifying tags.
     * @param {string} stat The dot-separated metric name.
     * @param {number} value The amount to increment the stat by.
     * @param {[tag:string]:string|number} tags Tags to pass along, such as `{ foo: 'bar' }`. Values are combined with config.tags.
     */
    gauge(stat: string, value?: number, tags?: { [tag: string]: string|number }): void

    /**
     * Sets a histogram value, optionally specifying tags.
     * @param {string} stat The dot-separated metric name.
     * @param {number} value The amount to increment the stat by.
     * @param {[tag:string]:string|number} tags Tags to pass along, such as `{ foo: 'bar' }`. Values are combined with config.tags.
     */
    histogram(stat: string, value?: number, tags?: { [tag: string]: string|number }): void

    /**
     * Forces any unsent metrics to be sent
     *
     * @beta This method is experimental and could be removed in future versions.
     */
    flush(): void
  }

  export interface Appsec {
    /**
     * Links a successful login event to the current trace. Will link the passed user to the current trace with Appsec.setUser() internally.
     * @param {User} user Properties of the authenticated user. Accepts custom fields.
     * @param {[key: string]: string} metadata Custom fields to link to the login success event.
     *
     * @beta This method is in beta and could change in future versions.
     */
    trackUserLoginSuccessEvent(user: User, metadata?: { [key: string]: string }): void

    /**
     * Links a failed login event to the current trace.
     * @param {string} userId The user id of the attemped login.
     * @param {boolean} exists If the user id exists.
     * @param {[key: string]: string} metadata Custom fields to link to the login failure event.
     *
     * @beta This method is in beta and could change in future versions.
     */
    trackUserLoginFailureEvent(userId: string, exists: boolean, metadata?: { [key: string]: string }): void

    /**
     * Links a custom event to the current trace.
     * @param {string} eventName The name of the event.
     * @param {[key: string]: string} metadata Custom fields to link to the event.
     *
     * @beta This method is in beta and could change in future versions.
     */
    trackCustomEvent(eventName: string, metadata?: { [key: string]: string }): void

    /**
     * Checks if the passed user should be blocked according to AppSec rules.
     * If no user is linked to the current trace, will link the passed user to it.
     * @param {User} user Properties of the authenticated user. Accepts custom fields.
     * @return {boolean} Indicates whether the user should be blocked.
     *
     * @beta This method is in beta and could change in the future
     */
    isUserBlocked(user: User): boolean

    /**
     * Sends a "blocked" template response based on the request accept header and ends the response.
     * **You should stop processing the request after calling this function!**
     * @param {IncomingMessage} req Can be passed to force which request to act on. Optional.
     * @param {OutgoingMessage} res Can be passed to force which response to act on. Optional.
     * @return {boolean} Indicates if the action was successful.
     *
     * @beta This method is in beta and could change in the future
     */
    blockRequest(req?: IncomingMessage, res?: OutgoingMessage): boolean

    /**
     * Links an authenticated user to the current trace.
     * @param {User} user Properties of the authenticated user. Accepts custom fields.
     *
     * @beta This method is in beta and could change in the future
     */
    setUser(user: User): void
  }

  /** @hidden */
  type anyObject = {
    [key: string]: any;
  };

  /** @hidden */
  interface TransportRequestParams {
    method: string;
    path: string;
    body?: anyObject;
    bulkBody?: anyObject;
    querystring?: anyObject;
  }

  /**
   * The Datadog Scope Manager. This is used for context propagation.
   */
  export interface Scope {
    /**
     * Get the current active span or null if there is none.
     *
     * @returns {Span} The active span.
     */
    active (): Span | null;

    /**
     * Activate a span in the scope of a function.
     *
     * @param {Span} span The span to activate.
     * @param {Function} fn Function that will have the span activated on its scope.
     * @returns The return value of the provided function.
     */
    activate<T> (span: Span, fn: ((...args: any[]) => T)): T;

    /**
     * Binds a target to the provided span, or the active span if omitted.
     *
     * @param {Function|Promise} fn Target that will have the span activated on its scope.
     * @param {Span} [span=scope.active()] The span to activate.
     * @returns The bound target.
     */
    bind<T extends (...args: any[]) => void> (fn: T, span?: Span | null): T;
    bind<V, T extends (...args: any[]) => V> (fn: T, span?: Span | null): T;
    bind<T> (fn: Promise<T>, span?: Span | null): Promise<T>;
  }

  /** @hidden */
  interface Analyzable {
    /**
     * Whether to measure the span. Can also be set to a key-value pair with span
     * names as keys and booleans as values for more granular control.
     */
    measured?: boolean | { [key: string]: boolean };
  }

  export namespace plugins {
    /** @hidden */
    interface Integration {
      /**
       * The service name to be used for this plugin.
       */
      service?: string | any;

      /** Whether to enable the plugin.
       * @default true
       */
      enabled?: boolean;
    }

    /** @hidden */
    interface Instrumentation extends Integration, Analyzable {}

    /** @hidden */
    interface Http extends Instrumentation {
      /**
       * List of URLs/paths that should be instrumented.
       *
       * Note that when used for an http client the entry represents a full
       * outbound URL (`https://example.org/api/foo`) but when used as a
       * server the entry represents an inbound path (`/api/foo`).
       *
       * @default /^.*$/
       */
      allowlist?: string | RegExp | ((urlOrPath: string) => boolean) | (string | RegExp | ((urlOrPath: string) => boolean))[];

      /**
       * Deprecated in favor of `allowlist`.
       *
       * @deprecated
       * @hidden
       */
      whitelist?: string | RegExp | ((urlOrPath: string) => boolean) | (string | RegExp | ((urlOrPath: string) => boolean))[];

      /**
       * List of URLs/paths that should not be instrumented. Takes precedence over
       * allowlist if a URL matches an entry in both.
       *
       * Note that when used for an http client the entry represents a full
       * outbound URL (`https://example.org/api/foo`) but when used as a
       * server the entry represents an inbound path (`/api/foo`).
       *
       * @default []
       */
      blocklist?: string | RegExp | ((urlOrPath: string) => boolean) | (string | RegExp | ((urlOrPath: string) => boolean))[];

      /**
       * Deprecated in favor of `blocklist`.
       *
       * @deprecated
       * @hidden
       */
      blacklist?: string | RegExp | ((urlOrPath: string) => boolean) | (string | RegExp | ((urlOrPath: string) => boolean))[];

      /**
       * An array of headers to include in the span metadata.
       *
       * @default []
       */
      headers?: string[];

      /**
       * Callback function to determine if there was an error. It should take a
       * status code as its only parameter and return `true` for success or `false`
       * for errors.
       *
       * @default code => code < 500
       */
      validateStatus?: (code: number) => boolean;

      /**
       * Enable injection of tracing headers into requests signed with AWS IAM headers.
       * Disable this if you get AWS signature errors (HTTP 403).
       *
       * @default false
       */
      enablePropagationWithAmazonHeaders?: boolean;
    }

    /** @hidden */
    interface HttpServer extends Http {
      /**
       * Callback function to determine if there was an error. It should take a
       * status code as its only parameter and return `true` for success or `false`
       * for errors.
       *
       * @default code => code < 500
       */
      validateStatus?: (code: number) => boolean;

      /**
       * Hooks to run before spans are finished.
       */
      hooks?: {
        /**
         * Hook to execute just before the request span finishes.
         */
        request?: (span?: Span, req?: IncomingMessage, res?: ServerResponse) => any;
      };

      /**
       * Whether to enable instrumentation of <plugin>.middleware spans
       *
       * @default true
       */
      middleware?: boolean;
    }

    /** @hidden */
    interface HttpClient extends Http {
      /**
       * Use the remote endpoint host as the service name instead of the default.
       *
       * @default false
       */
      splitByDomain?: boolean;

      /**
       * Callback function to determine if there was an error. It should take a
       * status code as its only parameter and return `true` for success or `false`
       * for errors.
       *
       * @default code => code < 400 || code >= 500
       */
      validateStatus?: (code: number) => boolean;

      /**
       * Hooks to run before spans are finished.
       */
      hooks?: {
        /**
         * Hook to execute just before the request span finishes.
         */
        request?: (span?: Span, req?: ClientRequest, res?: IncomingMessage) => any;
      };

      /**
       * List of urls to which propagation headers should not be injected
       */
      propagationBlocklist?: string | RegExp | ((url: string) => boolean) | (string | RegExp | ((url: string) => boolean))[];
    }

    /** @hidden */
    interface Http2Client extends Http {
      /**
       * Use the remote endpoint host as the service name instead of the default.
       *
       * @default false
       */
      splitByDomain?: boolean;

      /**
       * Callback function to determine if there was an error. It should take a
       * status code as its only parameter and return `true` for success or `false`
       * for errors.
       *
       * @default code => code < 400 || code >= 500
       */
      validateStatus?: (code: number) => boolean;
    }

    /** @hidden */
    interface Http2Server extends Http {
      /**
       * Callback function to determine if there was an error. It should take a
       * status code as its only parameter and return `true` for success or `false`
       * for errors.
       *
       * @default code => code < 500
       */
      validateStatus?: (code: number) => boolean;
    }

    /** @hidden */
    interface Grpc extends Instrumentation {
      /**
       * An array of metadata entries to record. Can also be a callback that returns
       * the key/value pairs to record. For example, using
       * `variables => variables` would record all variables.
       */
      metadata?: string[] | ((variables: { [key: string]: any }) => { [key: string]: any });
    }

    /** @hidden */
    interface Moleculer extends Instrumentation {
      /**
       * Whether to include context meta as tags.
       *
       * @default false
       */
      meta?: boolean;
    }

    /**
     * This plugin automatically instruments the
     * [aerospike](https://github.com/aerospike/aerospike-client-nodejs) for module versions >= v3.16.2.
     */
    interface aerospike extends Instrumentation {}

    /**
     * This plugin automatically instruments the
     * [amqp10](https://github.com/noodlefrenzy/node-amqp10) module.
     */
    interface amqp10 extends Instrumentation {}

    /**
     * This plugin automatically instruments the
     * [amqplib](https://github.com/squaremo/amqp.node) module.
     */
    interface amqplib extends Instrumentation {}

    /**
     * Currently this plugin automatically instruments
     * [@apollo/gateway](https://github.com/apollographql/federation) for module versions >= v2.3.0.
     * This module uses graphql operations to service requests & thus generates graphql spans.
     * We recommend disabling the graphql plugin if you only want to trace @apollo/gateway
     */
    interface apollo extends Instrumentation {
      /**
       * Whether to include the source of the operation within the query as a tag
       * on every span. This may contain sensitive information and should only be
       * enabled if sensitive data is always sent as variables and not in the
       * query text.
       *
       * @default false
       */
      source?: boolean;

      /**
       * Whether to enable signature calculation for the resource name. This can
       * be disabled if your apollo/gateway operations always have a name. Note that when
       * disabled all queries will need to be named for this to work properly.
       *
       * @default true
       */
      signature?: boolean;
    }

    /**
     * This plugin automatically instruments the
     * [aws-sdk](https://github.com/aws/aws-sdk-js) module.
     */
    interface aws_sdk extends Instrumentation {
      /**
       * Whether to add a suffix to the service name so that each AWS service has its own service name.
       * @default true
       */
      splitByAwsService?: boolean;

      /**
       * Hooks to run before spans are finished.
       */
      hooks?: {
        /**
         * Hook to execute just before the aws span finishes.
         */
        request?: (span?: Span, response?: anyObject) => any;
      };

      /**
       * Configuration for individual services to enable/disable them. Message
       * queue services can also configure the producer and consumer individually
       * by passing an object with a `producer` and `consumer` properties. The
       * list of valid service keys is in the service-specific section of
       * https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/Config.html
       */
      [key: string]: boolean | Object | undefined;
    }

    /**
     * This plugin patches the [bunyan](https://github.com/trentm/node-bunyan)
     * to automatically inject trace identifiers in log records when the
     * [logInjection](interfaces/traceroptions.html#logInjection) option is enabled
     * on the tracer.
     */
    interface bunyan extends Integration {}

    /**
     * This plugin automatically instruments the
     * [cassandra-driver](https://github.com/datastax/nodejs-driver) module.
     */
    interface cassandra_driver extends Instrumentation {}

    /**
     * This plugin automatically instruments the
     * [child_process](https://nodejs.org/api/child_process.html) module.
     */
    interface child_process extends Instrumentation {}

    /**
     * This plugin automatically instruments the
     * [connect](https://github.com/senchalabs/connect) module.
     */
    interface connect extends HttpServer {}

    /**
     * This plugin automatically instruments the
     * [couchbase](https://www.npmjs.com/package/couchbase) module.
     */
    interface couchbase extends Instrumentation {}

    /**
     * This plugin automatically instruments the
     * [cucumber](https://www.npmjs.com/package/@cucumber/cucumber) module.
     */
    interface cucumber extends Integration {}

    /**
     * This plugin automatically instruments the
     * [cypress](https://github.com/cypress-io/cypress) module.
     */
    interface cypress extends Integration {}

    /**
     * This plugin automatically instruments the
     * [dns](https://nodejs.org/api/dns.html) module.
     */
    interface dns extends Instrumentation {}

    /**
     * This plugin automatically instruments the
     * [elasticsearch](https://github.com/elastic/elasticsearch-js) module.
     */
    interface elasticsearch extends Instrumentation {
      /**
       * Hooks to run before spans are finished.
       */
      hooks?: {
        /**
         * Hook to execute just before the query span finishes.
         */
        query?: (span?: Span, params?: TransportRequestParams) => any;
      };
    }

    /**
     * This plugin automatically instruments the
     * [express](http://expressjs.com/) module.
     */
    interface express extends HttpServer {}

    /**
     * This plugin automatically instruments the
     * [fastify](https://www.fastify.io/) module.
     */
    interface fastify extends HttpServer {}

    /**
     * This plugin automatically instruments the
     * [fetch](https://nodejs.org/api/globals.html#fetch) global.
     */
    interface fetch extends HttpClient {}

    /**
     * This plugin patches the [generic-pool](https://github.com/coopernurse/node-pool)
     * module to bind the callbacks the the caller context.
     */
    interface generic_pool extends Integration {}

    /**
     * This plugin automatically instruments the
     * [@google-cloud/pubsub](https://github.com/googleapis/nodejs-pubsub) module.
     */
    interface google_cloud_pubsub extends Integration {}

    /** @hidden */
    interface ExecutionArgs {
      schema: any,
      document: any,
      rootValue?: any,
      contextValue?: any,
      variableValues?: any,
      operationName?: string,
      fieldResolver?: any,
      typeResolver?: any,
    }

    /**
     * This plugin automatically instruments the
     * [graphql](https://github.com/graphql/graphql-js) module.
     *
     * The `graphql` integration uses the operation name as the span resource name.
     * If no operation name is set, the resource name will always be just `query`,
     * `mutation` or `subscription`.
     *
     * For example:
     *
     * ```graphql
     * # good, the resource name will be `query HelloWorld`
     * query HelloWorld {
     *   hello
     *   world
     * }
     *
     * # bad, the resource name will be `query`
     * {
     *   hello
     *   world
     * }
     * ```
     */
    interface graphql extends Instrumentation {
      /**
       * The maximum depth of fields/resolvers to instrument. Set to `0` to only
       * instrument the operation or to `-1` to instrument all fields/resolvers.
       *
       * @default -1
       */
      depth?: number;

      /**
       * Whether to include the source of the operation within the query as a tag
       * on every span. This may contain sensitive information and sould only be
       * enabled if sensitive data is always sent as variables and not in the
       * query text.
       *
       * @default false
       */
      source?: boolean;

      /**
       * An array of variable names to record. Can also be a callback that returns
       * the key/value pairs to record. For example, using
       * `variables => variables` would record all variables.
       */
      variables?: string[] | ((variables: { [key: string]: any }) => { [key: string]: any });

      /**
       * Whether to collapse list items into a single element. (i.e. single
       * `users.*.name` span instead of `users.0.name`, `users.1.name`, etc)
       *
       * @default true
       */
      collapse?: boolean;

      /**
       * Whether to enable signature calculation for the resource name. This can
       * be disabled if your GraphQL operations always have a name. Note that when
       * disabled all queries will need to be named for this to work properly.
       *
       * @default true
       */
      signature?: boolean;

      /**
       * An object of optional callbacks to be executed during the respective
       * phase of a GraphQL operation. Undefined callbacks default to a noop
       * function.
       *
       * @default {}
       */
      hooks?: {
        execute?: (span?: Span, args?: ExecutionArgs, res?: any) => void;
        validate?: (span?: Span, document?: any, errors?: any) => void;
        parse?: (span?: Span, source?: any, document?: any) => void;
      }
    }

    /**
     * This plugin automatically instruments the
     * [grpc](https://github.com/grpc/grpc-node) module.
     */
    interface grpc extends Grpc {
      /**
       * Configuration for gRPC clients.
       */
      client?: Grpc,

      /**
       * Configuration for gRPC servers.
       */
      server?: Grpc
    }

    /**
     * This plugin automatically instruments the
     * [hapi](https://hapijs.com/) module.
     */
    interface hapi extends HttpServer {}

    /**
     * This plugin automatically instruments the
     * [http](https://nodejs.org/api/http.html) module.
     *
     * By default any option set at the root will apply to both clients and
     * servers. To configure only one or the other, use the `client` and `server`
     * options.
     */
    interface http extends HttpClient, HttpServer {
      /**
       * Configuration for HTTP clients.
       */
      client?: HttpClient | boolean,

      /**
       * Configuration for HTTP servers.
       */
      server?: HttpServer | boolean

      /**
       * Hooks to run before spans are finished.
       */
      hooks?: {
        /**
         * Hook to execute just before the request span finishes.
         */
        request?: (
          span?: Span,
          req?: IncomingMessage | ClientRequest,
          res?: ServerResponse | IncomingMessage
        ) => any;
      };
    }

    /**
     * This plugin automatically instruments the
     * [http2](https://nodejs.org/api/http2.html) module.
     *
     * By default any option set at the root will apply to both clients and
     * servers. To configure only one or the other, use the `client` and `server`
     * options.
     */
    interface http2 extends Http2Client, Http2Server {
      /**
       * Configuration for HTTP clients.
       */
      client?: Http2Client | boolean,

      /**
       * Configuration for HTTP servers.
       */
      server?: Http2Server | boolean
    }

    /**
     * This plugin automatically instruments the
     * [ioredis](https://github.com/luin/ioredis) module.
     */
    interface ioredis extends Instrumentation {
      /**
       * List of commands that should be instrumented. Commands must be in
       * lowercase for example 'xread'.
       *
       * @default /^.*$/
       */
      allowlist?: string | RegExp | ((command: string) => boolean) | (string | RegExp | ((command: string) => boolean))[];

      /**
       * Deprecated in favor of `allowlist`.
       *
       * @deprecated
       * @hidden
       */
      whitelist?: string | RegExp | ((command: string) => boolean) | (string | RegExp | ((command: string) => boolean))[];

      /**
       * List of commands that should not be instrumented. Takes precedence over
       * allowlist if a command matches an entry in both. Commands must be in
       * lowercase for example 'xread'.
       *
       * @default []
       */
      blocklist?: string | RegExp | ((command: string) => boolean) | (string | RegExp | ((command: string) => boolean))[];

      /**
       * Deprecated in favor of `blocklist`.
       *
       * @deprecated
       * @hidden
       */
      blacklist?: string | RegExp | ((command: string) => boolean) | (string | RegExp | ((command: string) => boolean))[];

      /**
       * Whether to use a different service name for each Redis instance based
       * on the configured connection name of the client.
       *
       * @default false
       */
      splitByInstance?: boolean;
    }

    /**
     * This plugin automatically instruments the
     * [jest](https://github.com/facebook/jest) module.
     */
    interface jest extends Integration {}

    /**
     * This plugin patches the [knex](https://knexjs.org/)
     * module to bind the promise callback the the caller context.
     */
    interface knex extends Integration {}

    /**
     * This plugin automatically instruments the
     * [koa](https://koajs.com/) module.
     */
    interface koa extends HttpServer {}

    /**
     * This plugin automatically instruments the
     * [kafkajs](https://kafka.js.org/) module.
     */
    interface kafkajs extends Instrumentation {}

    /**
     * This plugin automatically instruments the
     * [ldapjs](https://github.com/ldapjs/node-ldapjs/) module.
     */
    interface ldapjs extends Instrumentation {}

    /**
     * This plugin automatically instruments the
     * [mariadb](https://github.com/mariadb-corporation/mariadb-connector-nodejs) module.
     */
    interface mariadb extends mysql {}

    /**
     * This plugin automatically instruments the
     * [memcached](https://github.com/3rd-Eden/memcached) module.
     */
    interface memcached extends Instrumentation {}

    /**
     * This plugin automatically instruments the
     * [microgateway-core](https://github.com/apigee/microgateway-core) module.
     */
    interface microgateway_core extends HttpServer {}

    /**
     * This plugin automatically instruments the
     * [mocha](https://mochajs.org/) module.
     */
    interface mocha extends Integration {}

    /**
     * This plugin automatically instruments the
     * [moleculer](https://moleculer.services/) module.
     */
    interface moleculer extends Moleculer {
      /**
       * Configuration for Moleculer clients. Set to false to disable client
       * instrumentation.
       */
      client?: boolean | Moleculer;

      /**
       * Configuration for Moleculer servers. Set to false to disable server
       * instrumentation.
       */
      server?: boolean | Moleculer;
    }

    /**
     * This plugin automatically instruments the
     * [mongodb-core](https://github.com/mongodb-js/mongodb-core) module.
     */
    interface mongodb_core extends Instrumentation {
      /**
       * Whether to include the query contents in the resource name.
       */
      queryInResourceName?: boolean;
    }

    /**
     * This plugin automatically instruments the
     * [mongoose](https://mongoosejs.com/) module.
     */
    interface mongoose extends Instrumentation {}

    /**
     * This plugin automatically instruments the
     * [mysql](https://github.com/mysqljs/mysql) module.
     */
    interface mysql extends Instrumentation {
      service?: string | ((params: any) => string);
    }

    /**
     * This plugin automatically instruments the
     * [mysql2](https://github.com/sidorares/node-mysql2) module.
     */
    interface mysql2 extends mysql {}

    /**
     * This plugin automatically instruments the
     * [net](https://nodejs.org/api/net.html) module.
     */
    interface net extends Instrumentation {}

    /**
     * This plugin automatically instruments the
     * [next](https://nextjs.org/) module.
     */
    interface next extends Instrumentation {
      /**
       * Hooks to run before spans are finished.
       */
      hooks?: {
        /**
         * Hook to execute just before the request span finishes.
         */
        request?: (span?: Span, req?: IncomingMessage, res?: ServerResponse) => any;
      };
    }

    /**
     * This plugin automatically instruments the
     * [openai](https://platform.openai.com/docs/api-reference?lang=node.js) module.
     *
     * Note that for logs to work you'll need to set the `DD_API_KEY` environment variable.
     * You'll also need to adjust any firewall settings to allow the tracer to communicate
     * with `http-intake.logs.datadoghq.com`.
     *
     * Note that for metrics to work you'll need to enable
     * [DogStatsD](https://docs.datadoghq.com/developers/dogstatsd/?tab=hostagent#setup)
     * in the agent.
     */
    interface openai extends Instrumentation {}

    /**
     * This plugin automatically instruments the
     * [opensearch](https://github.com/opensearch-project/opensearch-js) module.
     */
    interface opensearch extends elasticsearch {}

    /**
     * This plugin automatically instruments the
     * [oracledb](https://github.com/oracle/node-oracledb) module.
     */
    interface oracledb extends Instrumentation {
      /**
       * The service name to be used for this plugin. If a function is used, it will be passed the connection parameters and its return value will be used as the service name.
       */
      service?: string | ((params: any) => string);
    }

    /**
     * This plugin automatically instruments the
     * [paperplane](https://github.com/articulate/paperplane) module.
     */
    interface paperplane extends HttpServer {}

    /**
    * This plugin automatically instruments the
    * [playwright](https://github.com/microsoft/playwright) module.
    */
    interface playwright extends Integration {}

    /**
     * This plugin automatically instruments the
     * [pg](https://node-postgres.com/) module.
     */
    interface pg extends Instrumentation {
      /**
       * The service name to be used for this plugin. If a function is used, it will be passed the connection parameters and its return value will be used as the service name.
       */
      service?: string | ((params: any) => string);
      /**
       * The database monitoring propagation mode to be used for this plugin.
       */
      dbmPropagationMode?: string;
    }

    /**
     * This plugin patches the [pino](http://getpino.io)
     * to automatically inject trace identifiers in log records when the
     * [logInjection](interfaces/traceroptions.html#logInjection) option is enabled
     * on the tracer.
     */
    interface pino extends Integration {}

    /**
     * This plugin automatically instruments the
     * [redis](https://github.com/NodeRedis/node_redis) module.
     */
    interface redis extends Instrumentation {
      /**
       * List of commands that should be instrumented.
       *
       * @default /^.*$/
       */
      allowlist?: string | RegExp | ((command: string) => boolean) | (string | RegExp | ((command: string) => boolean))[];

      /**
       * Deprecated in favor of `allowlist`.
       *
       * deprecated
       * @hidden
       */
      whitelist?: string | RegExp | ((command: string) => boolean) | (string | RegExp | ((command: string) => boolean))[];

      /**
       * List of commands that should not be instrumented. Takes precedence over
       * allowlist if a command matches an entry in both.
       *
       * @default []
       */
      blocklist?: string | RegExp | ((command: string) => boolean) | (string | RegExp | ((command: string) => boolean))[];

      /**
       * Deprecated in favor of `blocklist`.
       *
       * @deprecated
       * @hidden
       */
      blacklist?: string | RegExp | ((command: string) => boolean) | (string | RegExp | ((command: string) => boolean))[];
    }

    /**
     * This plugin automatically instruments the
     * [restify](http://restify.com/) module.
     */
    interface restify extends HttpServer {}

    /**
     * This plugin automatically instruments the
     * [rhea](https://github.com/amqp/rhea) module.
     */
    interface rhea extends Instrumentation {}

    /**
     * This plugin automatically instruments the
     * [router](https://github.com/pillarjs/router) module.
     */
    interface router extends Integration {}

    /**
    * This plugin automatically instruments the
    * [selenium-webdriver](https://www.npmjs.com/package/selenium-webdriver) module.
    */
    interface selenium extends Integration {}

    /**
     * This plugin automatically instruments the
     * [sharedb](https://github.com/share/sharedb) module.
     */
    interface sharedb extends Integration {
      /**
       * Hooks to run before spans are finished.
       */
      hooks?: {
        /**
         * Hook to execute just when the span is created.
         */
        receive?: (span?: Span, request?: any) => any;

        /**
         * Hook to execute just when the span is finished.
         */
        reply?: (span?: Span, request?: any, response?: any) => any;
      };
    }

    /**
     * This plugin automatically instruments the
     * [tedious](https://github.com/tediousjs/tedious/) module.
     */
    interface tedious extends Instrumentation {}

    /**
     * This plugin automatically instruments the
     * [undici](https://github.com/nodejs/undici) module.
     */
    interface undici extends HttpClient {}

    /**
     * This plugin patches the [winston](https://github.com/winstonjs/winston)
     * to automatically inject trace identifiers in log records when the
     * [logInjection](interfaces/traceroptions.html#logInjection) option is enabled
     * on the tracer.
     */
    interface winston extends Integration {}
  }

  export namespace opentelemetry {
    /**
     * A registry for creating named {@link Tracer}s.
     */
    export interface TracerProvider extends otel.TracerProvider {
      /**
       * Construct a new TracerProvider to register with @opentelemetry/api
       *
       * @returns TracerProvider A TracerProvider instance
       */
      new(): TracerProvider;

      /**
       * Returns a Tracer, creating one if one with the given name and version is
       * not already created.
       *
       * @param name The name of the tracer or instrumentation library.
       * @param version The version of the tracer or instrumentation library.
       * @param options The options of the tracer or instrumentation library.
       * @returns Tracer A Tracer with the given name and version
       */
      getTracer(name: string, version?: string, options?: any): Tracer;

      /**
       * Register this tracer provider with @opentelemetry/api
       */
      register(): void;
    }

    /**
     * Tracer provides an interface for creating {@link Span}s.
     */
    export interface Tracer extends otel.Tracer {
      /**
       * Starts a new {@link Span}. Start the span without setting it on context.
       *
       * This method do NOT modify the current Context.
       *
       * @param name The name of the span
       * @param [options] SpanOptions used for span creation
       * @param [context] Context to use to extract parent
       * @returns Span The newly created span
       * @example
       *     const span = tracer.startSpan('op');
       *     span.setAttribute('key', 'value');
       *     span.end();
       */
      startSpan(name: string, options?: SpanOptions, context?: Context): Span;

      /**
       * Starts a new {@link Span} and calls the given function passing it the
       * created span as first argument.
       * Additionally the new span gets set in context and this context is activated
       * for the duration of the function call.
       *
       * @param name The name of the span
       * @param [options] SpanOptions used for span creation
       * @param [context] Context to use to extract parent
       * @param fn function called in the context of the span and receives the newly created span as an argument
       * @returns return value of fn
       * @example
       *     const something = tracer.startActiveSpan('op', span => {
       *       try {
       *         do some work
       *         span.setStatus({code: SpanStatusCode.OK});
       *         return something;
       *       } catch (err) {
       *         span.setStatus({
       *           code: SpanStatusCode.ERROR,
       *           message: err.message,
       *         });
       *         throw err;
       *       } finally {
       *         span.end();
       *       }
       *     });
       *
       * @example
       *     const span = tracer.startActiveSpan('op', span => {
       *       try {
       *         do some work
       *         return span;
       *       } catch (err) {
       *         span.setStatus({
       *           code: SpanStatusCode.ERROR,
       *           message: err.message,
       *         });
       *         throw err;
       *       }
       *     });
       *     do some more work
       *     span.end();
       */
      startActiveSpan<F extends (span: Span) => unknown>(name: string, options: SpanOptions, context: otel.Context, fn: F): ReturnType<F>;
      startActiveSpan<F extends (span: Span) => unknown>(name: string, options: SpanOptions, fn: F): ReturnType<F>;
      startActiveSpan<F extends (span: Span) => unknown>(name: string, fn: F): ReturnType<F>;
    }

    /**
     * An interface that represents a span. A span represents a single operation
     * within a trace. Examples of span might include remote procedure calls or a
     * in-process function calls to sub-components. A Trace has a single, top-level
     * "root" Span that in turn may have zero or more child Spans, which in turn
     * may have children.
     *
     * Spans are created by the {@link Tracer.startSpan} method.
     */
    export interface Span extends otel.Span {
      /**
       * Returns the {@link SpanContext} object associated with this Span.
       *
       * Get an immutable, serializable identifier for this span that can be used
       * to create new child spans. Returned SpanContext is usable even after the
       * span ends.
       *
       * @returns the SpanContext object associated with this Span.
       */
      spanContext(): SpanContext;

      /**
       * Sets an attribute to the span.
       *
       * Sets a single Attribute with the key and value passed as arguments.
       *
       * @param key the key for this attribute.
       * @param value the value for this attribute. Setting a value null or
       *              undefined is invalid and will result in undefined behavior.
       */
      setAttribute(key: string, value: SpanAttributeValue): this;

      /**
       * Sets attributes to the span.
       *
       * @param attributes the attributes that will be added.
       *                   null or undefined attribute values
       *                   are invalid and will result in undefined behavior.
       */
      setAttributes(attributes: SpanAttributes): this;

      /**
       * Adds an event to the Span.
       *
       * @param name the name of the event.
       * @param [attributesOrStartTime] the attributes that will be added; these are
       *     associated with this event. Can be also a start time
       *     if type is {@link TimeInput} and 3rd param is undefined
       * @param [startTime] start time of the event.
       */
      addEvent(name: string, attributesOrStartTime?: SpanAttributes | TimeInput, startTime?: TimeInput): this;

      /**
       * Sets a status to the span. If used, this will override the default Span
       * status. Default is {@link otel.SpanStatusCode.UNSET}. SetStatus overrides the value
       * of previous calls to SetStatus on the Span.
       *
       * @param status the SpanStatus to set.
       */
      setStatus(status: SpanStatus): this;

      /**
       * Updates the Span name.
       *
       * This will override the name provided via {@link Tracer.startSpan}.
       *
       * Upon this update, any sampling behavior based on Span name will depend on
       * the implementation.
       *
       * @param name the Span name.
       */
      updateName(name: string): this;

      /**
       * Marks the end of Span execution.
       *
       * Call to End of a Span MUST not have any effects on child spans. Those may
       * still be running and can be ended later.
       *
       * Do not return `this`. The Span generally should not be used after it
       * is ended so chaining is not desired in this context.
       *
       * @param [endTime] the time to set as Span's end time. If not provided,
       *     use the current time as the span's end time.
       */
      end(endTime?: TimeInput): void;

      /**
       * Returns the flag whether this span will be recorded.
       *
       * @returns true if this Span is active and recording information like events
       *     with the `AddEvent` operation and attributes using `setAttributes`.
       */
      isRecording(): boolean;

      /**
       * Sets exception as a span event
       * @param exception the exception the only accepted values are string or Error
       * @param [time] the time to set as Span's event time. If not provided,
       *     use the current time.
       */
      recordException(exception: Exception, time?: TimeInput): void;

      /**
       * Causally links another span to the current span
       * @param {otel.SpanContext} context The context of the span to link to.
       * @param {SpanAttributes} attributes An optional key value pair of arbitrary values.
       * @returns {void}
       */
      addLink(context: otel.SpanContext, attributes?: SpanAttributes): void;
    }

    /**
     * A SpanContext represents the portion of a {@link Span} which must be
     * serialized and propagated along side of a {@link otel.Baggage}.
     */
    export interface SpanContext extends otel.SpanContext {
      /**
       * The ID of the trace that this span belongs to. It is worldwide unique
       * with practically sufficient probability by being made as 16 randomly
       * generated bytes, encoded as a 32 lowercase hex characters corresponding to
       * 128 bits.
       */
      traceId: string;

      /**
       * The ID of the Span. It is globally unique with practically sufficient
       * probability by being made as 8 randomly generated bytes, encoded as a 16
       * lowercase hex characters corresponding to 64 bits.
       */
      spanId: string;

      /**
       * Only true if the SpanContext was propagated from a remote parent.
       */
      isRemote?: boolean;

      /**
       * Trace flags to propagate.
       *
       * It is represented as 1 byte (bitmap). Bit to represent whether trace is
       * sampled or not. When set, the least significant bit documents that the
       * caller may have recorded trace data. A caller who does not record trace
       * data out-of-band leaves this flag unset.
       *
       * see {@link otel.TraceFlags} for valid flag values.
       */
      traceFlags: number;

      /**
       * Tracing-system-specific info to propagate.
       *
       * The tracestate field value is a `list` as defined below. The `list` is a
       * series of `list-members` separated by commas `,`, and a list-member is a
       * key/value pair separated by an equals sign `=`. Spaces and horizontal tabs
       * surrounding `list-members` are ignored. There can be a maximum of 32
       * `list-members` in a `list`.
       * More Info: https://www.w3.org/TR/trace-context/#tracestate-field
       *
       * Examples:
       *     Single tracing system (generic format):
       *         tracestate: rojo=00f067aa0ba902b7
       *     Multiple tracing systems (with different formatting):
       *         tracestate: rojo=00f067aa0ba902b7,congo=t61rcWkgMzE
       */
      traceState?: TraceState;
    }

    export type Context = otel.Context;
    export type Exception = otel.Exception;
    export type SpanAttributes = otel.SpanAttributes;
    export type SpanAttributeValue = otel.SpanAttributeValue;
    export type SpanOptions = otel.SpanOptions;
    export type SpanStatus = otel.SpanStatus;
    export type TimeInput = otel.TimeInput;
    export type TraceState = otel.TraceState;
  }
}

/**
 * Singleton returned by the module. It has to be initialized before it will
 * start tracing. If not initialized, or initialized and disabled, it will use
 * a no-op implementation.
 */
declare const tracer: Tracer;

export = tracer;
