const request = require('supertest');
const { createApp } = require('../src/app');

const baseConfig = {
  port: 3000,
  basePath: '/app3',
  nodeEnv: 'test',
  db: { user: 'appuser', password: 'super-secret-value' },
};

describe('app3 routes', () => {
  const app = createApp(baseConfig);

  test('GET /app3/health returns 200 ok', async () => {
    const res = await request(app).get('/app3/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  test('GET /app3 returns app info', async () => {
    const res = await request(app).get('/app3');
    expect(res.status).toBe(200);
    expect(res.body.app).toBe('app3');
    expect(res.body.dbUser).toBe('appuser');
    expect(res.body.secretLoaded).toBe(true);
  });

  test('GET /app3 never leaks the password', async () => {
    const res = await request(app).get('/app3');
    expect(JSON.stringify(res.body)).not.toContain('super-secret-value');
  });

  test('GET /app3/hello/:name greets the user', async () => {
    const res = await request(app).get('/app3/hello/Bipin');
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Hello, Bipin!');
  });

  test('unknown route returns 404', async () => {
    const res = await request(app).get('/app3/does-not-exist');
    expect(res.status).toBe(404);
  });

  test('x-powered-by header is disabled', async () => {
    const res = await request(app).get('/app3/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('secretLoaded flag', () => {
  test('is false when password missing', async () => {
    const app = createApp({ ...baseConfig, db: { user: 'appuser' } });
    const res = await request(app).get('/app3');
    expect(res.body.secretLoaded).toBe(false);
  });
});
