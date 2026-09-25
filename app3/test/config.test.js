const { loadConfig, validateConfig } = require('../src/config');

describe('loadConfig', () => {
  test('uses defaults when env is empty', () => {
    const c = loadConfig({});
    expect(c.port).toBe(3000);
    expect(c.basePath).toBe('');
    expect(c.nodeEnv).toBe('development');
  });

  test('reads values from env', () => {
    const c = loadConfig({
      PORT: '8080',
      BASE_PATH: '/app3',
      NODE_ENV: 'production',
      DB_USER: 'u',
      DB_PASSWORD: 'p',
    });
    expect(c.port).toBe(8080);
    expect(c.basePath).toBe('/app3');
    expect(c.db).toEqual({ user: 'u', password: 'p' });
  });
});

describe('validateConfig', () => {
  test('reports missing secrets', () => {
    expect(validateConfig(loadConfig({}))).toEqual(['DB_USER', 'DB_PASSWORD']);
  });

  test('passes when secrets are present', () => {
    expect(validateConfig(loadConfig({ DB_USER: 'u', DB_PASSWORD: 'p' }))).toEqual([]);
  });
});
