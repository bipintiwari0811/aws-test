// All config comes from environment variables.
// DB_USER / DB_PASSWORD are injected by ECS from AWS Secrets Manager.
function loadConfig(env = process.env) {
  return {
    port: parseInt(env.PORT || '3000', 10),
    basePath: env.BASE_PATH || '',
    nodeEnv: env.NODE_ENV || 'development',
    db: {
      user: env.DB_USER,
      password: env.DB_PASSWORD,
    },
  };
}

function validateConfig(config) {
  const missing = [];
  if (!config.db.user) missing.push('DB_USER');
  if (!config.db.password) missing.push('DB_PASSWORD');
  return missing;
}

module.exports = { loadConfig, validateConfig };
