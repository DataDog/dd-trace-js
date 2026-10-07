import ddtrace from 'dd-trace'
import bunyan from 'browser-bunyan'

ddtrace.init({
  logInjection: true,
})

class ConsoleJsonStream {
  write (rec) {
    console.log(JSON.stringify(rec)) // eslint-disable-line no-console
  }
}

const logger = bunyan.createLogger({ name: 'test-logger', stream: new ConsoleJsonStream() })

logger.info('test xyz')
