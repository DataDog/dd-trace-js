# How to measure CSI values in juice-shop

* Download juice-shop project and run `npm install`
* Download dd-trace-js in this branch
* In juice-shop project, run `npm install <path-to-local-dd-trace>`
* Create `init.js` file that initializes dd-trace
```
const tracer = require('dd-trace').init()
```
* Run the project
  * Without CSI
  ```shell
  node --require ./init build/app
  ```
  * With CSI, with node_modules
  ```shell
  env "DD_CSI_ENABLED=true" node --require ./init build/app
  ```
  * With CSI, excluding node_modules
  ```shell
  env "DD_CSI_ENABLED=true" "DD_CSI_EXCLUDE_NODE_MODULES=true" node --require ./init build/app
  ```

# How to measure startup time
* Add `global._dd_beforeStart = Date.now()` in `init.js` before initialize dd-trace
```javascript
global._dd_beforeStart = Date.now()
const tracer = require('dd-trace').init()
```

* In juice-shop application, in `server.ts` file add next block just after "Server listening on port" log line:
```javascript
logger.info(colors.cyan(`Server listening on port ${colors.bold(port)}`))
if (global._dd_beforeStart) {
  const current = Date.now()
  logger.info(`Started in ${current - global._dd_beforeStart}ms`)
}
```
* Run again `npm install` in juice-shop to force new build
* Run the project again with needed configuration properties
