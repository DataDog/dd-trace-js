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

void tracerOptions
void httpOptions
