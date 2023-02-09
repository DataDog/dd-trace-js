module.exports = {
  eslint: {
    ignoreDuringBuilds: true
  },
  webpack: (config, { buildId, dev, isServer, defaultLoaders, webpack }) => {
    config.module.rules.push({
      test: /\.node$/,
      loader: "node-loader",
    });

    // Important: return the modified config
    return config;
  },
}
