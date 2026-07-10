import type { plugins, TracerOptions } from '../index.d.v5'

const tracerOptions: TracerOptions[] = [
  { headerTags: { 'x-user-id': 'user.id' } },
  { headerTags: ['x-user-id:user.id'] },
]

const httpOptions: plugins.HttpServer[] = [
  { headers: { 'x-user-id': 'user.id' } },
  { headers: ['x-user-id:user.id'] },
]

void tracerOptions
void httpOptions
