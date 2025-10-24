const polka = require('polka');
const http = require('http');

class PolkaSampleApp {
  constructor() {
    this.app = null;
    this.server = null;
    this.port = 3000;
  }

  async setup() {
    try {
      // Create Polka app with routes
      this.app = polka();
      
      // Add some middleware
      this.app.use((req, res, next) => {
        console.log(`[Middleware] ${req.method} ${req.url}`);
        next();
      });
      
      // Add routes that will trigger the handler method
      this.app.get('/', (req, res) => {
        res.end('Hello from Polka!');
      });
      
      this.app.get('/api/users', (req, res) => {
        res.end(JSON.stringify({ users: ['Alice', 'Bob'] }));
      });
      
      this.app.post('/api/data', (req, res) => {
        res.end(JSON.stringify({ success: true }));
      });
      
      // Start the server
      await new Promise((resolve, reject) => {
        this.server = this.app.listen(this.port, (err) => {
          if (err) {
            reject(err);
          } else {
            console.log(`✓ Polka server listening on port ${this.port}`);
            resolve();
          }
        });
      });
    } catch (error) {
      console.error(`✗ Error in setup: ${error.message}`);
      throw error;
    }
  }

  async teardown() {
    try {
      if (this.server && this.server.server) {
        await new Promise((resolve) => {
          this.server.server.close(() => {
            console.log('✓ Polka server closed');
            resolve();
          });
        });
      }
    } catch (error) {
      console.error(`✗ Error in teardown: ${error.message}`);
    }
  }

  // Operation: handle_request
  // This triggers the Polka.handler method by making HTTP requests
  async handle_request() {
    try {
      console.log('Testing handle_request operation...');
      
      // Test GET request to root
      await this.makeRequest('GET', '/');
      
      // Test GET request to /api/users
      await this.makeRequest('GET', '/api/users');
      
      // Test POST request
      await this.makeRequest('POST', '/api/data', JSON.stringify({ test: 'data' }));

      console.log('✓ All handle_request operations completed');
    } catch (error) {
      console.error(`✗ Error in handle_request: ${error.message}`);
      // Continue execution
    }
  }

  makeRequest(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1',
        port: this.port,
        path: path,
        method: method,
        headers: {
          'Content-Type': 'application/json'
        }
      };

      const req = http.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          console.log(`  ✓ ${method} ${path} -> ${res.statusCode}`);
          resolve(data);
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      if (body) {
        req.write(body);
      }
      
      req.end();
    });
  }

  async runAll() {
    try {
      console.log('=== Starting Polka Sample App ===\n');
      
      await this.setup();
      
      console.log('\n--- Testing handle_request ---');
      await this.handle_request();
      
      console.log('\n=== Sample App Completed Successfully ===');
    } catch (error) {
      console.error(`\n✗ Fatal error: ${error.message}`);
      console.error(error.stack);
      process.exit(1);
    } finally {
      await this.teardown();
    }
  }
}

// Run the sample app
const app = new PolkaSampleApp();
app.runAll().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
