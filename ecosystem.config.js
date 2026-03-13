module.exports = {
  apps: [
    {
      name: 'perplexity-proxy',
      script: './index.js',
      cwd: __dirname,
      env: {
        HEADLESS: 'false'
      }
    }
  ]
};
