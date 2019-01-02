import { IncomingMessage, ServerResponse } from "http";
import * as opentracing from "opentracing";

/**
 * Tracer is the entry-point of the Datadog tracing implementation.
 */
declare class Tracer extends opentracing.Tracer {
  public startSpan(name: string, options?: SpanOptions): Span;
  public inject(spanContext: SpanContext | Span, format: string, carrier: any): void;
  public extract(format: string, carrier: any): SpanContext | null;

  /**
   * Initializes the tracer. This should be called before importing other libraries.
   */
  public init(options?: TracerOptions): this;

  /**
   * Enable and optionally configure a plugin.
   * @param plugin The name of a built-in plugin.
   * @param config Configuration options.
   */
  public use<P extends keyof Plugins>(plugin: P, config?: Plugins[P]): this;

  /**
   * Initiate a trace and creates a new span.
   * @param operationName The operation name to be used for this span.
   * @param options Configuration options. These will take precedence over environment variables.
   */
  public scopeManager(): ScopeManager;
}

interface SpanOptions {
  /**
   * a parent SpanContext (or Span, for convenience) that the newly-started
   * span will be the child of (per REFERENCE_CHILD_OF). If specified,
   * `references` must be unspecified.
   */
  childOf?: Span | SpanContext;
  /**
   * an array of Reference instances, each pointing to a causal parent
   * SpanContext. If specified, `fields.childOf` must be unspecified.
   */
  references?: opentracing.Reference[];
  /**
   * set of key-value pairs which will be set as tags on the newly created
   * Span. Ownership of the object is passed to the created span for
   * efficiency reasons (the caller should not modify this object after
   * calling startSpan).
   */
  tags?: {
      [key: string]: any;
  };
  /**
   * a manually specified start time for the created Span object. The time
   * should be specified in milliseconds as Unix timestamp. Decimal value are
   * supported to represent time values with sub-millisecond accuracy.
   */
  startTime?: number;
}

/**
 * Span represents a logical unit of work as part of a broader Trace.
 * Examples of span might include remote procedure calls or a in-process
 * function calls to sub-components. A Trace has a single, top-level "root"
 * Span that in turn may have zero or more child Spans, which in turn may
 * have children.
 */
declare class Span extends opentracing.Span {
  public context(): SpanContext;
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
declare class SpanContext extends opentracing.SpanContext {
  public toTraceId(): string;
  public toSpanId(): string;
}

interface TracerOptions {
  /**
   * Whether to enable the tracer.
   * @default true
   */
  enabled?: boolean;

  /**
   * Enable debug logging in the tracer.
   * @default false
   */
  debug?: boolean;

  /**
   * The service name to be used for this program. If not set, the service name
   * will attempted to be inferred from package.json
   */
  service?: string;

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
   * Set an application’s environment e.g. prod, pre-prod, stage.
   */
  env?: string;

  /**
   * Percentage of spans to sample as a float between 0 and 1.
   * @default 1
   */
  sampleRate?: number;

  /**
   * Interval in milliseconds at which the tracer will submit traces to the agent.
   * @default 2000
   */
  flushInterval?: number;

  /**
   * Experimental features can be enabled all at once by using true or individually using key / value pairs.
   * @default {}
   */
  experimental?: ExperimentalOptions | boolean;

  /**
   * Whether to load all built-in plugins.
   * @default true
   */
  plugins?: boolean;

  /**
   * Custom logger to be used by the tracer (if debug = true),
   * should support debug() and error() methods
   * see https://datadog.github.io/dd-trace-js/#custom-logging
   */
  logger?: {
    debug: (message: string) => void;
    error: (err: Error) => void;
  };

  /**
   * Global tags that should be assigned to every span.
   */
  tags?: { [key: string]: any };
}

interface ExperimentalOptions {}

declare class ScopeManager {
  /**
   * Get the current active scope or null if there is none.
   */
  public active(): Scope | null;

  /**
   * Activate a new scope wrapping the provided span.
   *
   * @param span The span for which to activate the new scope.
   * @param finishSpanOnClose Whether to automatically finish the span when the scope is closed.
   */
  public activate(span: opentracing.Span, finishSpanOnClose?: boolean): Scope;
}

declare class Scope {
  /**
   * Get the span wrapped by this scope.
   */
  public span(): opentracing.Span;

  /**
   * Close the scope, and finish the span if the scope was created with `finishSpanOnClose` set to true.
   */
  public close(): void;
}

/** @hidden */
interface Plugins {
  "amqp10": amqp10.Options;
  "amqplib": amqplib.Options;
  "bluebird": bluebird.Options;
  "elasticsearch": elasticsearch.Options;
  "express": express.Options;
  "graphql": graphql.Options;
  "hapi": hapi.Options;
  "http": http.Options;
  "ioredis": ioredis.Options;
  "koa": koa.Options;
  "memcached": memcached.Options;
  "mongodb-core": mongodb_core.Options;
  "mysql": mysql.Options;
  "mysql2": mysql2.Options;
  "pg": pg.Options;
  "q": q.Options;
  "redis": redis.Options;
  "restify": restify.Options;
  "router": router.Options;
  "when": when.Options;
}

/**
 * This plugin automatically instruments the
 * [amqp10](https://github.com/noodlefrenzy/node-amqp10) module.
 *
 * The following spans are automatically created by this integration:
 *
 * * **amqp.send**: Span when messages are sent.
 * * **amqp.receive**: Span when messages are received.
 *
 * Please see the available [options](../interfaces/amqp10.options.html) to
 * configure this plugin.
 */
declare namespace amqp10 {
  interface Options extends integration.Options {}
}

/**
 * This plugin automatically instruments the
 * [amqplib](https://github.com/squaremo/amqp.node) module.
 *
 * The following spans are automatically created by this integration:
 *
 * * **amqp.command**: Span for the AMQP command.
 *
 * Please see the available [options](../interfaces/amqplib.options.html) to
 * configure this plugin.
 */
declare namespace amqplib {
  interface Options extends integration.Options {}
}

/**
 * This plugin patches the [bluebird](https://github.com/squaremo/amqp.node)
 * module to bind the promise callback the the caller context.
 */
declare namespace bluebird {
  interface Options {}
}

/**
 * This plugin automatically instruments the
 * [elasticsearch](https://github.com/elastic/elasticsearch-js) module.
 *
 * The following spans are automatically created by this integration:
 *
 * * **elasticsearch.query**: Span for the query.
 *
 * Please see the available [options](../interfaces/elasticsearch.options.html) to
 * configure this plugin.
 */
declare namespace elasticsearch {
  interface Options extends integration.Options {}
}

/**
 * This plugin automatically instruments the
 * [express](http://expressjs.com/) module.
 *
 * The following spans are automatically created by this integration:
 *
 * * **express.request**: Span for the entire request.
 * * **express.middleware**: Span for each middleware.
 *
 * Please see the available [options](../interfaces/express.options.html) to
 * configure this plugin.
 */
declare namespace express {
  interface Options extends web.Options {}
}

/**
 * This plugin automatically instruments the
 * [graphql](https://github.com/graphql/graphql-js) module.
 *
 * The `graphql` integration uses the operation name as the span resource name. If no operation name is set, the resource name will always be just `query`, `mutation` or `subscription`.
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
 *
 * The following spans are automatically created by this integration:
 *
 * * **graphql.query**: Span for the GraphQL queries.
 * * **graphql.mutation**: Span for the GraphQL mutations.
 * * **graphql.subscription**: Span for the GraphQL subscriptions.
 * * **graphql.parse**: Span for the GraphQL document parsing.
 * * **graphql.validate**: Span for the GraphQL document validation.
 * * **graphql.execute**: Span for the GraphQL operation execution.
 * * **graphql.field**: Span for the GraphQL resolvers, including the duration of child resolvers.
 * * **graphql.resolver**: Span for GraphQL resolvers.
 *
 * Please see the available [options](../interfaces/graphql.options.html) to
 * configure this plugin.
 */
declare namespace graphql {
  interface Options extends integration.Options {
    /**
     * The maximum depth of fields/resolvers to instrument. Set to `0` to only
     * instrument the operation or to `-1` to instrument all fields/resolvers.
     */
    depth?: number;

    /**
     * A callback to enable recording of variables. By default, no variables are
     * recorded. For example, using `variables => variables` would record all
     * variables.
     */
    variables?: (variables: { [key: string]: any }) => { [key: string]: any };

    /**
     * Whether to collapse list items into a single element. (i.e. single
     * `users.*.name` span instead of `users.0.name`, `users.1.name`, etc)
     */
    collapse?: boolean;
  }
}

/**
 * This plugin automatically instruments the
 * [hapi](https://hapijs.com/) module.
 *
 * The following spans are automatically created by this integration:
 *
 * * **hapi.request**: Span for the entire request.
 *
 * Please see the available [options](../interfaces/hapi.options.html) to
 * configure this plugin.
 */
declare namespace hapi {
  interface Options extends web.Options {}
}

/**
 * This plugin automatically instruments the
 * [http](https://nodejs.org/api/http.html) module.
 *
 * The following spans are automatically created by this integration:
 *
 * * **http.request**: Span for the entire request.
 *
 * Please see the available [options](../interfaces/http.options.html) to
 * configure this plugin.
 */
declare namespace http {
  interface Options extends web.Options {
    /**
     * Use the remote endpoint host as the service name instead of the default.
     */
    splitByDomain?: boolean;
  }
}

/**
 * This plugin automatically instruments the
 * [ioredis](https://github.com/luin/ioredis) module.
 *
 * The following spans are automatically created by this integration:
 *
 * * **redis.command**: Span for the Redis command.
 *
 * Please see the available [options](../interfaces/ioredis.options.html) to
 * configure this plugin.
 */
declare namespace ioredis {
  interface Options extends integration.Options {}
}

/**
 * This plugin automatically instruments the
 * [koa](https://koajs.com/) module.
 *
 * The following spans are automatically created by this integration:
 *
 * * **koa.request**: Span for the entire request.
 *
 * Please see the available [options](../interfaces/koa.options.html) to
 * configure this plugin.
 */
declare namespace koa {
  interface Options extends web.Options {}
}

/**
 * This plugin automatically instruments the
 * [memcached](https://github.com/3rd-Eden/memcached) module.
 *
 * The following spans are automatically created by this integration:
 *
 * * **memcached.command**: Span for the Memcached command.
 *
 * Please see the available [options](../interfaces/memcached.options.html) to
 * configure this plugin.
 */
declare namespace memcached {
  interface Options extends integration.Options {}
}

/**
 * This plugin automatically instruments the
 * [mongodb-core](https://github.com/mongodb-js/mongodb-core) module.
 *
 * The following spans are automatically created by this integration:
 *
 * * **mongodb.query**: Span for the MongoDB query.
 *
 * Please see the available [options](../interfaces/mongodb_core.options.html) to
 * configure this plugin.
 */
declare namespace mongodb_core {
  interface Options extends integration.Options {}
}

/**
 * This plugin automatically instruments the
 * [mysql](https://github.com/mysqljs/mysql) module.
 *
 * The following spans are automatically created by this integration:
 *
 * * **mysql.query**: Span for the MySQL query.
 *
 * Please see the available [options](../interfaces/mysql.options.html) to
 * configure this plugin.
 */
declare namespace mysql {
  interface Options extends integration.Options {}
}

/**
 * This plugin automatically instruments the
 * [mysql2](https://github.com/brianmario/mysql2) module.
 *
 * The following spans are automatically created by this integration:
 *
 * * **mysql.query**: Span for the MySQL query.
 *
 * Please see the available [options](../interfaces/mysql2.options.html) to
 * configure this plugin.
 */
declare namespace mysql2 {
  interface Options extends integration.Options {}
}

/**
 * This plugin automatically instruments the
 * [pg](https://node-postgres.com/) module.
 *
 * The following spans are automatically created by this integration:
 *
 * * **postgres.query**: Span for the PostgreSQL query.
 *
 * Please see the available [options](../interfaces/pg.options.html) to
 * configure this plugin.
 */
declare namespace pg {
  interface Options extends integration.Options {}
}

/**
 * This plugin patches the [q](https://github.com/kriskowal/q)
 * module to bind the promise callback the the caller context.
 */
declare namespace q {
  interface Options {}
}

/**
 * This plugin automatically instruments the
 * [redis](https://github.com/NodeRedis/node_redis) module.
 *
 * The following spans are automatically created by this integration:
 *
 * * **redis.command**: Span for the Redis command.
 *
 * Please see the available [options](../interfaces/redis.options.html) to
 * configure this plugin.
 */
declare namespace redis {
  interface Options extends integration.Options {}
}

/**
 * This plugin automatically instruments the
 * [restify](http://restify.com/) module.
 *
 * The following spans are automatically created by this integration:
 *
 * * **restify.request**: Span for the entire request.
 *
 * Please see the available [options](../interfaces/restify.options.html) to
 * configure this plugin.
 */
declare namespace restify {
  interface Options extends web.Options {}
}

/**
 * This plugin automatically instruments the
 * [router](https://github.com/pillarjs/router) module.
 *
 * The following spans are automatically created by this integration:
 *
 * * **router.request**: Span for the entire request.
 *
 * Please see the available [options](../interfaces/router.options.html) to
 * configure this plugin.
 */
declare namespace router {
  interface Options extends integration.Options {}
}

/**
 * This plugin patches the [when](https://github.com/cujojs/when)
 * module to bind the promise callback the the caller context.
 */
declare namespace when {
  interface Options {}
}

/** @hidden */
declare namespace integration {
  export interface Options {
    /**
     * The service name to be used for this plugin.
     */
    service?: string;
  }
}

/** @hidden */
declare namespace web {
  export interface Options extends integration.Options {
    /**
     * An array of headers to include in the span metadata.
     */
    headers?: string[];

    /**
     * Callback function to determine if there was an error. It should take a
     * status code as its only parameter and return `true` for success or `false`
     * for errors.
     */
    validateStatus?: (code: number) => boolean;

    /**
     * Hooks to run before spans are finished.
     */
    hooks?: Hooks;
  }

  export interface Hooks {
    /**
     * Hook to execute just before the request span finishes.
     */
    request?: (span?: opentracing.Span, req?: IncomingMessage, res?: ServerResponse) => any;
  }
}

/**
 * Singleton returned by the module. It has to be initialized before it will
 * start tracing. If not initialized, or initialized and disabled, it will use
 * a no-op implementation.
 */
declare const tracer: Tracer;

export = tracer;
