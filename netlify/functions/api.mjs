import { getStore } from '@netlify/blobs';
import { createHandler } from '../lib/handler.mjs';

export default createHandler(() => getStore({ name: 'gespraechskalender', consistency: 'strong' }));

export const config = { path: '/api/*' };
