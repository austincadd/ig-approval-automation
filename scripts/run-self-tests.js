import { runSelfTestsForDefaultDb } from '../core/self-tests.js';

const result = await runSelfTestsForDefaultDb({});
console.log(JSON.stringify(result, null, 2));
