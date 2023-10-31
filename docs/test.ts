import { performance } from 'perf_hooks'
import ddTrace, { tracer, Tracer, TracerOptions, Span, SpanContext, SpanOptions, Scope, User } from '..';
import { opentelemetry } from '..';
import { formats, kinds, priority, tags, types } from '../ext';
import { BINARY, HTTP_HEADERS, LOG, TEXT_MAP } from '../ext/formats';
import { SERVER, CLIENT, PRODUCER, CONSUMER } from '../ext/kinds'
import { USER_REJECT, AUTO_REJECT, AUTO_KEEP, USER_KEEP } from '../ext/priority'
import {
  ERROR,
  HTTP_METHOD,
  HTTP_REQUEST_HEADERS,
  HTTP_RESPONSE_HEADERS,
  HTTP_ROUTE,
  HTTP_STATUS_CODE,
  HTTP_URL,
  HTTP_USERAGENT,
  HTTP_CLIENT_IP,
  MANUAL_DROP,
  MANUAL_KEEP,
  RESOURCE_NAME,
  SAMPLING_PRIORITY,
  SERVICE_NAME,
  SPAN_KIND,
  SPAN_TYPE,
} from '../ext/tags'
import { HTTP, WEB } from '../ext/types'
import * as opentracing from 'opentracing';
import { IncomingMessage, OutgoingMessage } from 'http';

opentracing.initGlobalTracer(tracer);

let span: Span;
let context: SpanContext;
let traceId: string;
let spanId: string;
let traceparent: string;
let promise: Promise<void>;

ddTrace.init();
tracer.init({
  logInjection: true,
  startupLogs: false,
  env: 'test',
  version: '1.0.0',
  url: 'http://localhost',
  runtimeMetrics: true,
  ingestion: {
    sampleRate: 0.5,
    rateLimit: 500
  },
  experimental: {
    iast: true,
    b3: true,
    runtimeId: true,
    exporter: 'log'
  },
  hostname: 'agent',
  logger: {
    error (message: string | Error) {},
    warn (message: string) {},
    info (message: string) {},
    debug (message: string) {}
  },
  plugins: false,
  port: 7777,
  dogstatsd: {
    hostname: 'dsd-agent',
    port: 8888
  },
  flushInterval: 1000,
  flushMinSpans: 500,
  lookup: () => {},
  sampleRate: 0.1,
  rateLimit: 1000,
  samplingRules: [
    { sampleRate: 0.5, service: 'foo', name: 'foo.request' },
    { sampleRate: 0.1, service: /foo/, name: /foo\.request/ }
  ],
  spanSamplingRules: [
    { sampleRate: 1.0, service: 'foo', name: 'foo.request', maxPerSecond: 5 },
    { sampleRate: 0.5, service: 'ba?', name: 'ba?.*', maxPerSecond: 10 }
  ],
  service: 'test',
  serviceMapping: {
    http: 'new-http-service-name'
  },
  tags: {
    foo: 'bar'
  },
  reportHostname: true,
  logLevel: 'debug',
  dbmPropagationMode: 'full',
  appsec: true,
  remoteConfig: {
    pollInterval: 5
  },
  clientIpEnabled: true,
  clientIpHeader: 'x-forwarded-for'
});

tracer.init({
  appsec: {
    enabled: true,
    rules: './rules.json',
    rateLimit: 100,
    wafTimeout: 100e3,
    obfuscatorKeyRegex: '.*',
    obfuscatorValueRegex: '.*',
    blockedTemplateHtml: './blocked.html',
    blockedTemplateJson: './blocked.json',
    eventTracking: {
      mode: 'safe'
    }
  }
});

tracer.init({
  experimental: {
    iast: {
      enabled: true,
      requestSampling: 50,
      maxConcurrentRequests: 4,
      maxContextOperations: 30,
      deduplicationEnabled: true,
      redactionEnabled: true,
      redactionNamePattern: 'password',
      redactionValuePattern: 'bearer'
    }
  }
})

tracer.dogstatsd.increment('foo')
tracer.dogstatsd.increment('foo', 2)
tracer.dogstatsd.increment('foo', 2, {a: 'b'})
tracer.dogstatsd.decrement('foo')
tracer.dogstatsd.decrement('foo', 2)
tracer.dogstatsd.decrement('foo', 2, {a: 'b'})
tracer.dogstatsd.distribution('foo')
tracer.dogstatsd.distribution('foo', 2)
tracer.dogstatsd.distribution('foo', 2, {a: 'b'})
tracer.dogstatsd.gauge('foo')
tracer.dogstatsd.gauge('foo', 2)
tracer.dogstatsd.gauge('foo', 2, {a: 'b'})
tracer.dogstatsd.flush()

const httpOptions = {
  service: 'test',
  allowlist: ['url', /url/, url => true],
  blocklist: ['url', /url/, url => true],
  validateStatus: code => code < 400,
  headers: ['host'],
  middleware: true
};

const httpServerOptions = {
  ...httpOptions,
  hooks: {
    request: (span: Span, req, res) => {}
  }
};

const httpClientOptions = {
  ...httpOptions,
  splitByDomain: true,
  propagationBlocklist: ['url', /url/, url => true],
  hooks: {
    request: (span: Span, req, res) => {}
  }
};

const http2ServerOptions = {
  ...httpOptions
};

const http2ClientOptions = {
  ...httpOptions,
  splitByDomain: true
};

const nextOptions = {
  service: 'test',
  hooks: {
    request: (span: Span, params) => { },
  },
};

const graphqlOptions = {
  service: 'test',
  depth: 2,
  source: true,
  variables: ({ foo, baz }) => ({ foo }),
  collapse: false,
  signature: false,
  hooks: {
    execute: (span: Span, args, res) => {},
    validate: (span: Span, document, errors) => {},
    parse: (span: Span, source, document) => {}
  }
};

const elasticsearchOptions = {
  service: 'test',
  hooks: {
    query: (span: Span, params) => {},
  },
};

const awsSdkOptions = {
  service: 'test',
  splitByAwsService: false,
  hooks: {
    request: (span: Span, response) => {},
  },
  s3: false,
  sqs: {
    consumer: true,
    producer: false
  }
};

const redisOptions = {
  service: 'test',
  allowlist: ['info', /auth/i, command => true],
  blocklist: ['info', /auth/i, command => true],
};

const sharedbOptions = {
  service: 'test',
  hooks: {
    receive: (span: Span, request) => {},
    reply: (span: Span, request, reply) => {},
  },
};

const moleculerOptions = {
  service: 'test',
  client: false,
  params: true,
  server: {
    meta: true
  }
};

const openSearchOptions = {
  service: 'test',
  hooks: {
    query: (span: Span, params) => {},
  },
};

tracer.use('amqp10');
tracer.use('amqplib');
tracer.use('aws-sdk');
tracer.use('aws-sdk', awsSdkOptions);
tracer.use('bunyan');
tracer.use('couchbase');
tracer.use('cassandra-driver');
tracer.use('connect');
tracer.use('connect', httpServerOptions);
tracer.use('cypress');
tracer.use('cucumber')
tracer.use('cucumber', { service: 'cucumber-service' });
tracer.use('dns');
tracer.use('elasticsearch');
tracer.use('elasticsearch', elasticsearchOptions);
tracer.use('express');
tracer.use('express', httpServerOptions);
tracer.use('fastify');
tracer.use('fastify', httpServerOptions);
tracer.use('fetch');
tracer.use('fetch', httpClientOptions);
tracer.use('generic-pool');
tracer.use('google-cloud-pubsub');
tracer.use('graphql');
tracer.use('graphql', graphqlOptions);
tracer.use('graphql', { variables: ['foo', 'bar'] });
tracer.use('grpc');
tracer.use('grpc', { metadata: ['foo', 'bar'] });
tracer.use('grpc', { metadata: meta => meta });
tracer.use('grpc', { client: { metadata: [] } });
tracer.use('grpc', { server: { metadata: [] } });
tracer.use('hapi');
tracer.use('hapi', httpServerOptions);
tracer.use('http');
tracer.use('http', {
  server: httpServerOptions
});
tracer.use('http', {
  client: httpClientOptions
});
tracer.use('http2');
tracer.use('http2', {
  server: http2ServerOptions
});
tracer.use('http2', {
  client: http2ClientOptions
});
tracer.use('ioredis');
tracer.use('ioredis', redisOptions);
tracer.use('ioredis', { splitByInstance: true });
tracer.use('jest');
tracer.use('jest', { service: 'jest-service' });
tracer.use('kafkajs');
tracer.use('knex');
tracer.use('koa');
tracer.use('koa', httpServerOptions);
tracer.use('mariadb', { service: () => `my-custom-mariadb` })
tracer.use('memcached');
tracer.use('microgateway-core');
tracer.use('microgateway-core', httpServerOptions);
tracer.use('mocha');
tracer.use('mocha', { service: 'mocha-service' });
tracer.use('moleculer', moleculerOptions);
tracer.use('mongodb-core');
tracer.use('mongoose');
tracer.use('mysql');
tracer.use('mysql', { service: () => `my-custom-mysql` });
tracer.use('mysql2');
tracer.use('mysql2', { service: () => `my-custom-mysql2` });
tracer.use('net');
tracer.use('next');
tracer.use('next', nextOptions);
tracer.use('opensearch');
tracer.use('opensearch', openSearchOptions);
tracer.use('oracledb');
tracer.use('oracledb', { service: params => `${params.host}-${params.database}` });
tracer.use('paperplane');
tracer.use('paperplane', httpServerOptions);
tracer.use('playwright');
tracer.use('pg');
tracer.use('pg', { service: params => `${params.host}-${params.database}` });
tracer.use('pino');
tracer.use('redis');
tracer.use('redis', redisOptions);
tracer.use('restify');
tracer.use('restify', httpServerOptions);
tracer.use('rhea');
tracer.use('router');
tracer.use('sharedb');
tracer.use('sharedb', sharedbOptions);
tracer.use('tedious');
tracer.use('winston');

tracer.use('express', false)
tracer.use('express', { enabled: false })
tracer.use('express', { service: 'name' });
tracer.use('express', { measured: true });

span = tracer.startSpan('test');
span = tracer.startSpan('test', {});
span = tracer.startSpan('test', {
  childOf: span || span.context(),
  references: [],
  startTime: 123456789.1234,
  tags: {
    foo: 'bar'
  }
});

tracer.trace('test', () => {})
tracer.trace('test', { tags: { foo: 'bar' } }, () => {})
tracer.trace('test', { service: 'foo', resource: 'bar', type: 'baz' }, () => {})
tracer.trace('test', { measured: true }, () => {})
tracer.trace('test', (span: Span) => {})
tracer.trace('test', (span: Span, fn: () => void) => {})
tracer.trace('test', (span: Span, fn: (err: Error) => string) => {})

promise = tracer.trace('test', () => Promise.resolve())

tracer.wrap('test', () => {})
tracer.wrap('test', (foo: string) => 'test')

promise = tracer.wrap('test', () => Promise.resolve())()

const carrier = {}

tracer.inject(span || span.context(), HTTP_HEADERS, carrier);
context = tracer.extract(HTTP_HEADERS, carrier);

traceId = context.toTraceId();
spanId = context.toSpanId();
traceparent = context.toTraceparent();

const scope = tracer.scope()

span = scope.active();

const activateStringType: string = scope.activate(span, () => 'test');
const activateVoidType: void = scope.activate(span, () => {});

const bindFunctionStringType: (arg1: string, arg2: number) => string = scope.bind((arg1: string, arg2: number): string => 'test');
const bindFunctionVoidType: (arg1: string, arg2: number) => void = scope.bind((arg1: string, arg2: number): void => {});
const bindFunctionVoidTypeWithSpan: (arg1: string, arg2: number) => void = scope.bind((arg1: string, arg2: number): string => 'test', span);

tracer.wrap('x', () => {
  const rumData: string = tracer.getRumData();
})

const result: Tracer = tracer.setUser({ id: '123' })

const user: User = {
  id: '123',
  email: 'a@b.c',
  custom: 'hello'
}

const meta = {
  metakey: 'metavalue',
  metakey2: 'metavalue2'
}

tracer.appsec.trackUserLoginSuccessEvent(user)
tracer.appsec.trackUserLoginSuccessEvent(user, meta)

tracer.appsec.trackUserLoginFailureEvent('user_id', true)
tracer.appsec.trackUserLoginFailureEvent('user_id', true, meta)
tracer.appsec.trackUserLoginFailureEvent('user_id', false)
tracer.appsec.trackUserLoginFailureEvent('user_id', false, meta)

tracer.appsec.trackCustomEvent('event_name')
tracer.appsec.trackCustomEvent('event_name', meta)

tracer.setUser(user)

const resUserBlock: boolean = tracer.appsec.isUserBlocked(user)
let resBlockRequest: boolean = tracer.appsec.blockRequest()
const req = {} as IncomingMessage
const res = {} as OutgoingMessage
resBlockRequest = tracer.appsec.blockRequest(req, res)
tracer.appsec.setUser(user)

// OTel TracerProvider registers and provides a tracer
const provider: opentelemetry.TracerProvider = new tracer.TracerProvider();
provider.register();

const otelTracer: opentelemetry.Tracer = provider.getTracer("name", "version")

// OTel supports several time input formats
otelTracer.startSpan("name", { startTime: new Date() })
otelTracer.startSpan("name", { startTime: Date.now() })
otelTracer.startSpan("name", { startTime: process.hrtime() })
otelTracer.startSpan("name", { startTime: performance.now() })

// OTel spans can be marked as root spans
otelTracer.startSpan("name", { root: true })

// OTel can start an active span with or without span options
otelTracer.startActiveSpan("name", (span) => span.end())
otelTracer.startActiveSpan("name", {}, (span) => span.end())

// OTel attributes (this maps to dd tags)
const otelSpan: opentelemetry.Span = otelTracer.startSpan("name", {
  attributes: {
    string: "value",
    number: 1,
    boolean: true
  }
})

// OTel spans expose span context
const spanContext: opentelemetry.SpanContext = otelSpan.spanContext()

// OTel spans can be renamed
otelSpan.updateName("new name")

// OTel spans can have their attributes changed
otelSpan.setAttribute("string", "value")
otelSpan.setAttribute("number", 1)
otelSpan.setAttribute("boolean", true)

otelSpan.setAttributes({
  string: "value",
  number: 1,
  boolean: true
})

// OTel spans can have their status set
otelSpan.setStatus({ code: 0, message: "unset" })
otelSpan.setStatus({ code: 1, message: "ok" })
otelSpan.setStatus({ code: 2, message: "error" })

// OTel spans can expose if they are being recorded or not
const recording: boolean = otelSpan.isRecording()

// OTel spans can record exceptions
otelSpan.recordException(new Error('error'))

// OTel spans can be ended with an optional timestamp
otelSpan.end(Date.now())

// OTel span contexts can expose ids, flags, and tracestate header data
const otelTraceId: string = spanContext.traceId
const otelSpanId: string = spanContext.spanId
const otelTraceFlags: number = spanContext.traceFlags
const otelTraceState: opentelemetry.TraceState = spanContext.traceState!
