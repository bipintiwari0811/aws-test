const express = require('express');

function createApp(config) {
  const app = express();
  const router = express.Router();

  app.disable('x-powered-by');
  app.use(express.json());

  // Used by the ALB target group health check: /app3/health
  router.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  router.get('/', (_req, res) => {
    res.json({
      app: 'app3',
      environment: config.nodeEnv,
      dbUser: config.db.user || null,
      // Never return the password itself - only whether it was loaded ok
      secretLoaded: Boolean(config.db.password),
    });
  });

  router.get('/hello/:name', (req, res) => {
    res.json({ message: `Hello, ${req.params.name}!` });
  });

  app.use(config.basePath || '/', router);

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  return app;
}

module.exports = { createApp };
