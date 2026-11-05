import { serve } from './tests/server.mjs';
import { fileURLToPath } from 'node:url';
const site = await serve(fileURLToPath(new URL('.', import.meta.url)), Number(process.env.PORT || 4174));
console.log(`Neon Fist: ${site.url}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => site.server.close(() => process.exit(0)));
