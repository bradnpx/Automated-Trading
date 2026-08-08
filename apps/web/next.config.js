/** @type {import('next').NextConfig} */
const nextConfig = {
  // Ensure the shared types package is transpiled by Next.js
  transpilePackages: ["@my-platform/types"],
};

export default nextConfig;
