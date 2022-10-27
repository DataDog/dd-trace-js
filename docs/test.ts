import ddTrace, { tracer, Tracer, TracerOptions, Span, SpanContext, SpanOptions, Scope } from '..';
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

opentracing.initGlobalTracer(tracer);

let span: Span;
let context: SpanContext;
let traceId: string;
let spanId: string;
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
  tags: {
    foo: 'bar'
  },
  reportHostname: true,
  logLevel: 'debug',
  appsec: true
});

tracer.init({
  appsec: {
    enabled: true,
    rules: './rules.json',
    rateLimit: 100,
    wafTimeout: 100e3,
    obfuscatorKeyRegex: '.*',
    obfuscatorValueRegex: '.*'
  }
});

tracer.init({
  experimental: {
    iast: {
      enabled: true,
      requestSampling: 50,
      maxConcurrentRequests: 4,
      maxContextOperations: 30
    }
  }
})

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
    request: (span, req, res) => {}
  }
};

const httpClientOptions = {
  ...httpOptions,
  splitByDomain: true,
  propagationBlocklist: ['url', /url/, url => true],
  hooks: {
    request: (span, req, res) => {}
  }
};

const http2ServerOptions = {
  ...httpOptions
};

const http2ClientOptions = {
  ...httpOptions,
  splitByDomain: true
};

const graphqlOptions = {
  service: 'test',
  depth: 2,
  source: true,
  variables: ({ foo, baz }) => ({ foo }),
  collapse: false,
  signature: false,
  hooks: {
    execute: (span, args, res) => {},
    validate: (span, document, errors) => {},
    parse: (span, source, document) => {}
  }
};

const elasticsearchOptions = {
  service: 'test',
  hooks: {
    query: (span, params) => {},
  },
};

const awsSdkOptions = {
  service: 'test',
  splitByAwsService: false,
  hooks: {
    request: (span, response) => {},
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
    receive: (span, request) => {},
    reply: (span, request, reply) => {},
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
    query: (span, params) => {},
  },
};

tracer.use('amqp10');
tracer.use('amqplib');
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
tracer.use('elasticsearch', elasticsearchOptions);
tracer.use('express');
tracer.use('express', httpServerOptions);
tracer.use('fastify');
tracer.use('fastify', httpServerOptions);
tracer.use('generic-pool');
tracer.use('google-cloud-pubsub');
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
tracer.use('opensearch', openSearchOptions);
tracer.use('oracledb');
tracer.use('oracledb', { service: params => `${params.host}-${params.database}` });
tracer.use('paperplane');
tracer.use('paperplane', httpServerOptions);
tracer.use('pg');
tracer.use('pg', { service: params => `${params.host}-${params.database}` });
tracer.use('pino');
tracer.use('redis');
tracer.use('redis', redisOptions);
tracer.use('restify');
tracer.use('restify', httpServerOptions);
tracer.use('rhea');
tracer.use('router');
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
tracer.trace('test', { tags: { foo: 'bar' }}, () => {})
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

tracer.setUser({
  id: '123',
  email: 'a@b.c',
  custom: 'hello'
})
