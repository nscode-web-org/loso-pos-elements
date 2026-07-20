import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Custom elements need a DOM with a real CustomElementRegistry and shadow
    // root support. happy-dom provides both and starts faster than jsdom.
    environment: 'happy-dom',
  },
});
