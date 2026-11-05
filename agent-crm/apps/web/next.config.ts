import type { NextConfig } from 'next';

const serverUrl = process.env.SERVER_URL ?? 'http://localhost:3000';

// The browser talks to one origin, so the session cookie from Better Auth works without CORS.
const config: NextConfig = {
  async rewrites() {
    return [
      { source: '/api/auth/:path*', destination: `${serverUrl}/api/auth/:path*` },
      { source: '/v1/:path*', destination: `${serverUrl}/v1/:path*` },
    ];
  },
};

export default config;
