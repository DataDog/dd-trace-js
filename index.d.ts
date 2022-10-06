import { ClientRequest, IncomingMessage, ServerResponse } from "http";
import { LookupFunction } from 'net';
import * as opentracing from "opentracing";
import { SpanOptions } from "opentracing/lib/tracer";

export { SpanOptions };

/**
 * Tracer is the entry-point of the Datadog tracing implementation.
 */
export declare interface Tracer extends opentracing.Tracer {
  /**
   * Starts and returns a new Span representing a logical unit of work.
   * @param {string} name The name of the operation.
   * @param {SpanOptions} [options] Options for the newly created span.
   * @returns {Span} A new Span object.
   */
  startSpan(name: string, options?: SpanOptions): Span;

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
  inject(spanContext: SpanContext | Span, format: string, carrier: any): void;

  /**
   * Returns a SpanContext instance extracted from `carrier` in the given
   * `format`.
   * @param  {string} format The format of the carrier.
   * @param  {any} carrier The carrier object.
   * @return {SpanContext}
   *         The extracted SpanContext, or null if no such SpanContext could
   *         be found in `carrier`
   */
  extract(format: string, carrier: any): SpanContext | null;

  /**
   * Initializes the tracer. This should be called before importing other libraries.
   */
  init(options?: TracerOptions): this;

  /**
   * Sets the URL for the trace agent. This should only be called _after_
   * init() is called, only in cases where the URL needs to be set after
   * initialization.
   */
  setUrl(url: string): this;

  /**
   * Enable and optionally configure a plugin.
   * @param plugin The name of a built-in plugin.
   * @param config Configuration options. Can also be `false` to disable the plugin.
   */
  use<P extends keyof Plugins>(plugin: P, config?: Plugins[P] | boolean): this;

  /**
   * Returns a reference to the current scope.
   */
  scope(): Scope;

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
   * unless there is already an active span or `childOf` option.
   */
  trace<T>(name: string, fn: (span?: Span, fn?: (error?: Error) => any) => T): T;
  trace<T>(name: string, options: TraceOptions & SpanOptions, fn: (span?: Span, done?: (error?: Error) => string) => T): T;

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
  wrap<T = (...args: any[]) => any>(name: string, fn: T, requiresParent?: boolean): T;
  wrap<T = (...args: any[]) => any>(name: string, options: TraceOptions & SpanOptions, fn: T): T;
  wrap<T = (...args: any[]) => any>(name: string, options: (...args: any[]) => TraceOptions & SpanOptions, fn: T): T;

  /**
   * Create and return a string that can be included in the <head> of a
   * document to enable RUM tracing to include it. The resulting string
   * should not be cached.
   */
  getRumData(): string;

  /**
   * Links an authenticated user to the current trace.
   * @param {User} user Properties of the authenticated user. Accepts custom fields.
   * @returns {Tracer} The Tracer instance for chaining.
   */
  setUser(user: User): Tracer;
}

export declare interface TraceOptions extends Analyzable {
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
}

/**
 * Span represents a logical unit of work as part of a broader Trace.
 * Examples of span might include remote procedure calls or a in-process
 * function calls to sub-components. A Trace has a single, top-level "root"
 * Span that in turn may have zero or more child Spans, which in turn may
 * have children.
 */
export declare interface Span extends opentracing.Span {
  context(): SpanContext;
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
export declare interface SpanContext extends opentracing.SpanContext {
  /**
   * Returns the string representation of the internal trace ID.
   */
  toTraceId(): string;

  /**
   * Returns the string representation of the internal span ID.
   */
  toSpanId(): string;
}

/**
 * Sampling rule to configure on the priority sampler.
 */
export declare interface SamplingRule {
  /**
   * Sampling rate for this rule.
   */
  sampleRate: Number

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
 * List of options available to the tracer.
 */
export declare interface TracerOptions {
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
  rateLimit?: Number,

  /**
   * Sampling rules to apply to priority samplin. Each rule is a JSON,
   * consisting of `service` and `name`, which are regexes to match against
   * a trace's `service` and `name`, and a corresponding `sampleRate`. If not
   * specified, will defer to global sampling rate for all spans.
   * @default []
   */
  samplingRules?: SamplingRule[]

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
     * Whether to write traces to log output, rather than send to an agent
     * @default false
     */
    exporter?: 'log' | 'agent'

    /**
     * Whether to enable the experimental `getRumData` method.
     * @default false
     */
    enableGetRumData?: boolean

    /**
     * Configuration of the IAST. Can be a boolean as an alias to `iast.enabled`.
     */
    iast?: boolean  | {
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
      maxContextOperations?: number
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
   */
  orphanable?: boolean

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
    obfuscatorValueRegex?: string
  };
}

/**
 * User object that can be passed to `tracer.setUser()`.
 */
 export declare interface User {
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

/** @hidden */
declare type anyObject = {
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
export declare interface Scope {
  /**
   * Get the current active span or null if there is none.
   *
   * @returns {Span} The active span.
   */
  active(): Span | null;

  /**
   * Activate a span in the scope of a function.
   *
   * @param {Span} span The span to activate.
   * @param {Function} fn Function that will have the span activated on its scope.
   * @returns The return value of the provided function.
   */
  activate<T>(span: Span, fn: ((...args: any[]) => T)): T;

  /**
   * Binds a target to the provided span, or the active span if omitted.
   *
   * @param {Function|Promise} target Target that will have the span activated on its scope.
   * @param {Span} [span=scope.active()] The span to activate.
   * @returns The bound target.
   */
  bind<T extends (...args: any[]) => void>(fn: T, span?: Span | null): T;
  bind<V, T extends (...args: any[]) => V>(fn: T, span?: Span | null): T;
  bind<T>(fn: Promise<T>, span?: Span | null): Promise<T>;
}

/** @hidden */
interface Plugins {
  "amqp10": plugins.amqp10;
  "amqplib": plugins.amqplib;
  "aws-sdk": plugins.aws_sdk;
  "bunyan": plugins.bunyan;
  "cassandra-driver": plugins.cassandra_driver;
  "connect": plugins.connect;
  "couchbase": plugins.couchbase;
  "cucumber": plugins.cucumber;
  "cypress": plugins.cypress;
  "dns": plugins.dns;
  "elasticsearch": plugins.elasticsearch;
  "express": plugins.express;
  "fastify": plugins.fastify;
  "generic-pool": plugins.generic_pool;
  "google-cloud-pubsub": plugins.google_cloud_pubsub;
  "graphql": plugins.graphql;
  "grpc": plugins.grpc;
  "hapi": plugins.hapi;
  "http": plugins.http;
  "http2": plugins.http2;
  "ioredis": plugins.ioredis;
  "jest": plugins.jest;
  "kafkajs": plugins.kafkajs
  "knex": plugins.knex;
  "koa": plugins.koa;
  "mariadb": plugins.mariadb;
  "memcached": plugins.memcached;
  "microgateway-core": plugins.microgateway_core;
  "mocha": plugins.mocha;
  "moleculer": plugins.moleculer;
  "mongodb-core": plugins.mongodb_core;
  "mongoose": plugins.mongoose;
  "mysql": plugins.mysql;
  "mysql2": plugins.mysql2;
  "net": plugins.net;
  "next": plugins.next;
  "oracledb": plugins.oracledb;
  "paperplane": plugins.paperplane;
  "pg": plugins.pg;
  "pino": plugins.pino;
  "redis": plugins.redis;
  "restify": plugins.restify;
  "rhea": plugins.rhea;
  "router": plugins.router;
  "sharedb": plugins.sharedb;
  "tedious": plugins.tedious;
  "winston": plugins.winston;
}

/** @hidden */
interface Analyzable {
  /**
   * Whether to measure the span. Can also be set to a key-value pair with span
   * names as keys and booleans as values for more granular control.
   */
  measured?: boolean | { [key: string]: boolean };
}

declare namespace plugins {
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
     * List of URLs that should be instrumented.
     *
     * @default /^.*$/
     */
    allowlist?: string | RegExp | ((url: string) => boolean) | (string | RegExp | ((url: string) => boolean))[];

    /**
     * Deprecated in favor of `allowlist`.
     *
     * @deprecated
     * @hidden
     */
    whitelist?: string | RegExp | ((url: string) => boolean) | (string | RegExp | ((url: string) => boolean))[];

    /**
     * List of URLs that should not be instrumented. Takes precedence over
     * allowlist if a URL matches an entry in both.
     *
     * @default []
     */
    blocklist?: string | RegExp | ((url: string) => boolean) | (string | RegExp | ((url: string) => boolean))[];

    /**
     * Deprecated in favor of `blocklist`.
     *
     * @deprecated
     * @hidden
     */
    blacklist?: string | RegExp | ((url: string) => boolean) | (string | RegExp | ((url: string) => boolean))[];

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
      request?: (span?: opentracing.Span, req?: IncomingMessage, res?: ServerResponse) => any;
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
     * @default code => code < 400
     */
    validateStatus?: (code: number) => boolean;

    /**
     * Hooks to run before spans are finished.
     */
    hooks?: {
      /**
       * Hook to execute just before the request span finishes.
       */
      request?: (span?: opentracing.Span, req?: ClientRequest, res?: IncomingMessage) => any;
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
     * @default code => code < 400
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
   * [amqp10](https://github.com/noodlefrenzy/node-amqp10) module.
   */
  interface amqp10 extends Instrumentation {}

  /**
   * This plugin automatically instruments the
   * [amqplib](https://github.com/squaremo/amqp.node) module.
   */
  interface amqplib extends Instrumentation {}

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
      request?: (span?: opentracing.Span, response?: anyObject) => any;
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
      query?: (span?: opentracing.Span, params?: TransportRequestParams) => any;
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
     * be disabled if your GraphQL operations always have a name.
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
        span?: opentracing.Span,
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
     * List of commands that should be instrumented.
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
  interface mongodb_core extends Instrumentation {}

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
      request?: (span?: opentracing.Span, req?: IncomingMessage, res?: ServerResponse) => any;
    };
  }

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
   * [pg](https://node-postgres.com/) module.
   */
  interface pg extends Instrumentation {
    /**
     * The service name to be used for this plugin. If a function is used, it will be passed the connection parameters and its return value will be used as the service name.
     */
    service?: string | ((params: any) => string);
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
      receive?: (span?: opentracing.Span, request?: any) => any;

      /**
       * Hook to execute just when the span is finished.
       */
      reply?: (span?: opentracing.Span, request?: any, response?: any) => any;
    };
  }

  /**
   * This plugin automatically instruments the
   * [tedious](https://github.com/tediousjs/tedious/) module.
   */
  interface tedious extends Instrumentation {}

  /**
   * This plugin patches the [winston](https://github.com/winstonjs/winston)
   * to automatically inject trace identifiers in log records when the
   * [logInjection](interfaces/traceroptions.html#logInjection) option is enabled
   * on the tracer.
   */
  interface winston extends Integration {}
}

/**
 * Singleton returned by the module. It has to be initialized before it will
 * start tracing. If not initialized, or initialized and disabled, it will use
 * a no-op implementation.
 */
export declare const tracer: Tracer;

export default tracer;
