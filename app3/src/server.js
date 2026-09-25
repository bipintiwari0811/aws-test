const { createApp } = require('./app');
const { loadConfig, validateConfig } = require('./config');

const config = loadConfig();
const missing = validateConfig(config);

if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')} - check task definition Secrets and execution role`);
  process.exit(1);
}

const app = createApp(config);

const server = app.listen(config.port, () => {
  console.log(`app3 listening on port ${config.port}${config.basePath}`);
});

// Graceful shutdown when ECS stops the task
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down');
  server.close(() => process.exit(0));
});
