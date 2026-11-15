import { securityHeaderEntries } from './lib/security-headers.js';

const config = {
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaderEntries(),
      },
    ];
  },
};

export default config;
