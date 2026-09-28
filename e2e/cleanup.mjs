// Deletes every e2e+* user created by earlier (possibly crashed) runs. Usage: E2E_* env + `npm run e2e:cleanup`
import { readE2EEnv } from './support/env.js';
import { adminApi } from './support/admin.js';

const env = readE2EEnv();
if (!env) { console.error('E2E_* env not set'); process.exit(2); }
const testPhoneDigits = env.testPhone ? env.testPhone.replace(/^\+/, '') : undefined;
const n = await adminApi(env).deleteRunUsers('e2e+', testPhoneDigits);
console.log(`Deleted ${n} e2e user(s).`);
