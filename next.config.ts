import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "nanobnana.com",
      },
    ],
  },
};

export default nextConfig;
