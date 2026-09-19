import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxies /api to the Express backend from Lab 3.6's chat-agent (npm start,
// port 3000) so ChatWidget's relative fetch('/api/chat') works unchanged in
// dev instead of needing a hardcoded backend origin.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
