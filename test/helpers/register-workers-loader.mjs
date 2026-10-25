import { register } from 'node:module';

// `node --import ./test/helpers/register-workers-loader.mjs`. register() rather
// than module.registerHooks(), which landed in Node 22.15: the loader predates
// the 22.23.4 floor, and register() still works on the whole 22 line.
register(new URL('./workers-loader.mjs', import.meta.url));
