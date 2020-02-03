import ddTrace, { tracer, Tracer, TracerOptions, Span, SpanContext, SpanOptions, Scope } from '..';
import { formats, kinds, priority, tags, types } from '../ext';
import { BINARY, HTTP_HEADERS, LOG, TEXT_MAP } from '../ext/formats';
import { SERVER, CLIENT, PRODUCER, CONSUMER } from '../ext/kinds'
import { USER_REJECT, AUTO_REJECT, AUTO_KEEP, USER_KEEP } from '../ext/priority'
import {
  ANALYTICS,
  ERROR,
  HTTP_METHOD,
  HTTP_REQUEST_HEADERS,
  HTTP_RESPONSE_HEADERS,
  HTTP_ROUTE,
  HTTP_STATUS_CODE,
  HTTP_URL,
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
  debug: true,
  enabled: true,
  logInjection: true,
  analytics: true,
  env: 'test',
  url: 'http://localhost',
  runtimeMetrics: true,
  trackAsyncScope: false,
  experimental: {
    b3: true,
    runtimeId: true,
    exporter: 'log',
    peers: ['foo', /bar/],
    sampler: {
      sampleRate: 1,
      rateLimit: 1000,
      rules: [
        { sampleRate: 0.5, service: 'foo', name: 'foo.request' },
        { sampleRate: 0.1, service: /foo/, name: /foo\.request/ }
      ]
    }
  },
  hostname: 'agent',
  logger: {
    error (message: string) {},
    debug (message: string | Error) {}
  },
  plugins: false,
  port: 7777,
  dogstatsd: {
    port: 8888
  },
  flushInterval: 1000,
  sampleRate: 0.1,
  service: 'test',
  tags: {
    foo: 'bar'
  },
  reportHostname: true,
  scope: 'noop',
  clientToken: 'pub123abc',
  logLevel: 'debug'
});

const httpOptions = {
  service: 'test',
  whitelist: ['url', /url/, url => true],
  blacklist: ['url', /url/, url => true],
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
  variables: ({ foo, baz }) => ({ foo }),
  collapse: false,
  signature: false
};

const elasticsearchOptions = {
  service: 'test',
  hooks: {
    query: (span, params) => {},
  },
};

tracer.use('amqp10');
tracer.use('amqplib');
tracer.use('bluebird');
tracer.use('bunyan');
tracer.use('couchbase');
tracer.use('cassandra-driver');
tracer.use('connect');
tracer.use('connect', httpServerOptions);
tracer.use('dns');
tracer.use('elasticsearch', elasticsearchOptions);
tracer.use('express');
tracer.use('express', httpServerOptions);
tracer.use('fastify');
tracer.use('fastify', httpServerOptions);
tracer.use('fs');
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
tracer.use('knex');
tracer.use('koa');
tracer.use('koa', httpServerOptions);
tracer.use('limitd-client');
tracer.use('memcached');
tracer.use('mongodb-core');
tracer.use('mysql');
tracer.use('mysql2');
tracer.use('net');
tracer.use('paperplane');
tracer.use('paperplane', httpServerOptions);
tracer.use('pg');
tracer.use('pino');
tracer.use('promise-js');
tracer.use('promise');
tracer.use('q');
tracer.use('redis');
tracer.use('restify');
tracer.use('restify', httpServerOptions);
tracer.use('rhea');
tracer.use('router');
tracer.use('tedious');
tracer.use('when');
tracer.use('winston');

tracer.use('express', false)
tracer.use('express', { enabled: false })
tracer.use('express', { service: 'name' });
tracer.use('express', { analytics: true });

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
tracer.trace('test', { analytics: true }, () => {})
tracer.trace('test', { analytics: 0.5 }, () => {})
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

Promise.resolve();

scope.bind(promise);
scope.bind(promise, span);

const simpleEmitter = {
  emit (eventName: string, arg1: boolean, arg2: number): void {}
};

scope.bind(simpleEmitter);
scope.bind(simpleEmitter, span);

const emitter = {
  emit (eventName: string, arg1: boolean, arg2: number): void {},
  on (eventName: string, listener: (arg1: boolean, arg2: number) => void) {},
  off (eventName: string, listener: (arg1: boolean, arg2: number) => void) {},
  addListener (eventName: string, listener: (arg1: boolean, arg2: number) => void) {},
  removeListener (eventName: string, listener: (arg1: boolean, arg2: number) => void) {}
};

scope.bind(emitter);
scope.bind(emitter, span);
