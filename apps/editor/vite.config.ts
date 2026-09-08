import { defineConfig } from 'vite';
export default defineConfig({ server: { proxy: { '/email': 'http://127.0.0.1:4310', '/v1': 'http://127.0.0.1:4310', '/auth': 'http://127.0.0.1:4310' } } });
