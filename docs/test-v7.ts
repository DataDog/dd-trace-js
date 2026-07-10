import type { plugins, TracerOptions } from '../index.d.v7'

const tracerOptions: TracerOptions = {
  headerTags: {
    'x-user-id': 'user.id',
    'x-team': '',
  },
}

const httpOptions: plugins.HttpServer = {
  headers: {
    'x-user-id': 'user.id',
    'x-team': '',
  },
}

const legacyTracerOptions: TracerOptions = {
  // @ts-expect-error The array form was removed in v7.
  headerTags: ['x-user-id:user.id'],
}

const legacyHttpOptions: plugins.HttpServer = {
  // @ts-expect-error The array form was removed in v7.
  headers: ['x-user-id:user.id'],
}

void tracerOptions
void httpOptions
void legacyTracerOptions
void legacyHttpOptions
