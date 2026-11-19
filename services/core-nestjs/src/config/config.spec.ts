import { cargarConfig } from './config';

const BASE: Record<string, string> = {
  JWT_SECRET: 'j'.repeat(40),
  WEBHOOK_HMAC_SECRET: 'w'.repeat(40),
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  S3_BUCKET: 'bucket',
  API_KEYS: `admin:ADMIN:${'a'.repeat(30)},aprobador:APROBADOR:${'b'.repeat(30)}`,
};

describe('cargarConfig', () => {
  it('carga valores por defecto seguros', () => {
    const cfg = cargarConfig({ ...BASE });
    expect(cfg.port).toBe(3000);
    expect(cfg.llm.provider).toBe('local-deterministic');
    expect(cfg.queue.driver).toBe('redis');
    expect(cfg.apiKeys.map((k) => k.rol)).toEqual(['ADMIN', 'APROBADOR']);
    expect(cfg.aws.endpoint).toBeUndefined();
  });

  it.each([
    [{ JWT_SECRET: 'corto' }, /JWT_SECRET/],
    [{ WEBHOOK_HMAC_SECRET: 'corto' }, /WEBHOOK_HMAC_SECRET/],
    [{ DATABASE_URL: '' }, /DATABASE_URL/],
    [{ API_KEYS: `x:ROOT:${'a'.repeat(30)}` }, /rol/],
    [{ API_KEYS: 'x:ADMIN:corta' }, /24 caracteres/],
    [{ API_KEYS: 'formato-invalido' }, /nombre:ROL:clave/],
    [{ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '' }, /ANTHROPIC_API_KEY/],
    [{ LLM_PROVIDER: 'otro' }, /LLM_PROVIDER/],
    [{ QUEUE_DRIVER: 'sqs', SQS_QUEUE_URL: '' }, /SQS_QUEUE_URL/],
    [{ PORT: '99999' }, /PORT/],
  ])('rechaza configuraciones inválidas %j', (sobrescritura, patron) => {
    expect(() => cargarConfig({ ...BASE, ...sobrescritura })).toThrow(patron);
  });
});
