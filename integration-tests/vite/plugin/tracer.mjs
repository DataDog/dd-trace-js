import tracer from 'dd-trace'

tracer.init({ service: 'vite-plugin-app', flushInterval: 0 })
