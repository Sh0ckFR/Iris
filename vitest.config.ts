import { defineConfig } from 'vitest/config';

/** Unit tests (npm test): the app's pure logic, without the Tauri shell or the network. */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});