import { securityHeaderEntries } from './lib/security-headers.js';

export default {
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaderEntries(),
      },
    ];
  },
};
