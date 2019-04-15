import ddTrace, { tracer, Tracer, TracerOptions, Span, SpanContext, SpanOptions, Scope } from '..';
import { HTTP_HEADERS } from '../ext/formats';
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
  runtimeMetrics: true,
  experimental: {},
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
  sampleRate: 0.1,
  service: 'test',
  tags: {
    foo: 'bar'
  }
});

const httpOptions = {
  service: 'test',
  whitelist: ['url', /url/, url => true],
  blacklist: ['url', /url/, url => true],
  validateStatus: code => code < 400,
  headers: ['host']
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

const graphqlOptions = {
  service: 'test',
  depth: 2,
  variables: ({ foo, baz }) => ({ foo }),
  collapse: false,
  signature: false
};

tracer.use('amqp10');
tracer.use('amqplib');
tracer.use('bluebird');
tracer.use('bunyan');
tracer.use('cassandra-driver');
tracer.use('dns');
tracer.use('elasticsearch');
tracer.use('express');
tracer.use('express', httpServerOptions);
tracer.use('generic-pool');
tracer.use('graphql', graphqlOptions);
tracer.use('hapi');
tracer.use('hapi', httpServerOptions);
tracer.use('http');
tracer.use('http', {
  server: httpServerOptions
});
tracer.use('http', {
  client: httpClientOptions
});
tracer.use('ioredis');
tracer.use('koa');
tracer.use('koa', httpServerOptions);
tracer.use('memcached');
tracer.use('mongodb-core');
tracer.use('mysql');
tracer.use('mysql2');
tracer.use('net');
tracer.use('pg');
tracer.use('pino');
tracer.use('q');
tracer.use('redis');
tracer.use('restify');
tracer.use('restify', httpServerOptions);
tracer.use('router');
tracer.use('when');
tracer.use('winston');

tracer.use('express', false)
tracer.use('express', { enabled: false })
tracer.use('express', { service: 'name' });
tracer.use('express', { analytics: true });
tracer.use('express', { analytics: { enabled: true, sampleRate: 0.5 } });
tracer.use('express', { analytics: { sampleRates: { 'express.request': 0.5 } } });

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
