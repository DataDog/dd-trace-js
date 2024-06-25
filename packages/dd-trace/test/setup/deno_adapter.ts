import process from 'node:process';
import { createRequire } from 'node:module';

process._getActiveHandles = () => [];
process._getActiveRequests = () => [];
process.execPath = `${process.argv[0]} run -A adapter.ts`;

const require = createRequire(import.meta.url);

if (Deno.args[0].startsWith('file:')) {
  require(require('node:url').fileURLToPath(Deno.args[0]));
} else {
  require(require('path').resolve(Deno.args[0]));
}
