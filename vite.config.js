import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
  },
  // Deployed behind a platform proxy (nixpacks start), so accept any Host header.
  preview: {
    allowedHosts: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
