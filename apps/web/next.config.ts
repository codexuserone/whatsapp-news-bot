import type { NextConfig } from 'next';

const appRoot = process.cwd();

const nextConfig: NextConfig & { turbopack?: { root?: string } } = {
  output: 'export',
  images: {
    unoptimized: true
  },
  outputFileTracingRoot: appRoot,
  turbopack: {
    root: appRoot
  }
};

export default nextConfig;
