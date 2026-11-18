import { AsyncLocalStorage } from 'node:async_hooks';
import { SpanStatusCode, trace } from '@opentelemetry/api';

// ============================== Tokens de inyección ==============================
export const TOKENS = {
  CONFIG: Symbol('CONFIG'),
  POOL: Symbol('POOL'),
  REDIS: Symbol('REDIS'),
  S3: Symbol('S3'),
  SQS: Symbol('SQS'),
  CLAVES: Symbol('CLAVES'),
  FLUJOS: Symbol('FLUJOS'),
  EJECUCIONES: Symbol('EJECUCIONES'),
  PASOS: Symbol('PASOS'),
  APROBACIONES: Symbol('APROBACIONES'),
  CATALOGO: Symbol('CATALOGO'),
  AUDITORIA: Symbol('AUDITORIA'),
  NOTIFICADOR: Symbol('NOTIFICADOR'),
  ALMACEN: Symbol('ALMACEN'),
  COLA: Symbol('COLA'),
  FUENTE: Symbol('FUENTE'),
  RELOJ: Symbol('RELOJ'),
  IDS: Symbol('IDS'),
  LLM: Symbol('LLM'),
} as const;

// ============================== Configuración ==============================
export type RolApi = 'ADMIN' | 'APROBADOR';

export interface ClaveApiConfig {
  readonly nombre: string;
  readonly rol: RolApi;
  readonly clave: string;
}

export interface AppConfig {
  readonly nodeEnv: string;
  readonly port: number;
  readonly logLevel: string;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly aws: {
    readonly region: string;
    readonly endpoint: string | undefined;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly bucket: string;
  };
  readonly queue: { readonly driver: 'redis' | 'sqs'; readonly sqsQueueUrl: string };
  readonly jwt: { readonly secret: string; readonly expiresIn: string };
  readonly webhookSecret: string;
  readonly rateLimit: { readonly max: number; readonly windowSeconds: number };
  readonly llm: {
    readonly provider: 'local-deterministic' | 'anthropic';
    readonly anthropicApiKey: string;
    readonly anthropicModel: string;
  };
  readonly apiKeys: readonly ClaveApiConfig[];
  readonly corsOrigins: readonly string[];
  readonly otel: { readonly endpoint: string; readonly serviceName: string };
}

function requerida(env: NodeJS.ProcessEnv, nombre: string): string {
  const valor = env[nombre];
  if (valor === undefined || valor.trim() === '') {
    throw new Error(`Variable de entorno requerida: ${nombre}`);
  }
  return valor.trim();
}

function entero(env: NodeJS.ProcessEnv, nombre: string, porDefecto: number, min: number, max: number): number {
  const crudo = env[nombre];
  if (crudo === undefined || crudo.trim() === '') return porDefecto;
  const valor = Number.parseInt(crudo, 10);
  if (!Number.isInteger(valor) || valor < min || valor > max) {
    throw new Error(`${nombre} debe ser un entero entre ${min} y ${max}`);
  }
  return valor;
}

function parsearClaves(crudo: string): ClaveApiConfig[] {
  const claves = crudo
    .split(',')
    .map((parte) => parte.trim())
    .filter((parte) => parte.length > 0)
    .map((entrada): ClaveApiConfig => {
      const partes = entrada.split(':');
      if (partes.length !== 3) {
        throw new Error('API_KEYS debe tener el formato nombre:ROL:clave');
      }
      const nombre = partes[0] as string;
      const rol = partes[1] as string;
      const clave = partes[2] as string;
      if (!/^[a-zA-Z0-9_.-]{1,60}$/.test(nombre)) {
        throw new Error('API_KEYS: nombre inválido');
      }
      if (rol !== 'ADMIN' && rol !== 'APROBADOR') {
        throw new Error('API_KEYS: el rol debe ser ADMIN o APROBADOR');
      }
      if (clave.length < 24) {
        throw new Error('API_KEYS: cada clave debe tener al menos 24 caracteres');
      }
      return { nombre, rol, clave };
    });
  if (claves.length === 0) {
    throw new Error('API_KEYS debe definir al menos una clave');
  }
  return claves;
}

export function cargarConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const jwtSecret = requerida(env, 'JWT_SECRET');
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET debe tener al menos 32 caracteres');
  const webhookSecret = requerida(env, 'WEBHOOK_HMAC_SECRET');
  if (webhookSecret.length < 32) throw new Error('WEBHOOK_HMAC_SECRET debe tener al menos 32 caracteres');

  const proveedor = (env['LLM_PROVIDER'] ?? 'local-deterministic').trim();
  if (proveedor !== 'local-deterministic' && proveedor !== 'anthropic') {
    throw new Error('LLM_PROVIDER debe ser local-deterministic o anthropic');
  }
  const anthropicApiKey = (env['ANTHROPIC_API_KEY'] ?? '').trim();
  if (proveedor === 'anthropic' && anthropicApiKey === '') {
    throw new Error('ANTHROPIC_API_KEY es requerida cuando LLM_PROVIDER=anthropic');
  }

  const driver = (env['QUEUE_DRIVER'] ?? 'redis').trim();
  if (driver !== 'redis' && driver !== 'sqs') throw new Error('QUEUE_DRIVER debe ser redis o sqs');
  const sqsQueueUrl = (env['SQS_QUEUE_URL'] ?? '').trim();
  if (driver === 'sqs' && sqsQueueUrl === '') throw new Error('SQS_QUEUE_URL es requerida cuando QUEUE_DRIVER=sqs');

  const endpoint = (env['AWS_ENDPOINT_URL'] ?? '').trim();

  return {
    nodeEnv: env['NODE_ENV'] ?? 'production',
    port: entero(env, 'PORT', 3000, 1, 65535),
    logLevel: (env['LOG_LEVEL'] ?? 'info').trim(),
    databaseUrl: requerida(env, 'DATABASE_URL'),
    redisUrl: requerida(env, 'REDIS_URL'),
    aws: {
      region: (env['AWS_REGION'] ?? 'us-east-2').trim(),
      endpoint: endpoint === '' ? undefined : endpoint,
      accessKeyId: requerida(env, 'AWS_ACCESS_KEY_ID'),
      secretAccessKey: requerida(env, 'AWS_SECRET_ACCESS_KEY'),
      bucket: requerida(env, 'S3_BUCKET'),
    },
    queue: { driver: driver === 'sqs' ? 'sqs' : 'redis', sqsQueueUrl },
    jwt: { secret: jwtSecret, expiresIn: (env['JWT_EXPIRES_IN'] ?? '15m').trim() },
    webhookSecret,
    rateLimit: {
      max: entero(env, 'RATE_LIMIT_MAX', 60, 1, 100_000),
      windowSeconds: entero(env, 'RATE_LIMIT_WINDOW_SECONDS', 60, 1, 3600),
    },
    llm: {
      provider: proveedor === 'anthropic' ? 'anthropic' : 'local-deterministic',
      anthropicApiKey,
      anthropicModel: (env['ANTHROPIC_MODEL'] ?? 'claude-sonnet-4-5').trim(),
    },
    apiKeys: parsearClaves(requerida(env, 'API_KEYS')),
    corsOrigins: (env['CORS_ORIGINS'] ?? 'http://localhost:5173,http://127.0.0.1:5173')
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0),
    otel: {
      endpoint: (env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://otel-collector:4318').trim(),
      serviceName: (env['OTEL_SERVICE_NAME'] ?? 'core-nestjs').trim(),
    },
  };
}

// ============================== Correlación y trazas ==============================
export const almacenCorrelacion = new AsyncLocalStorage<string>();

export function correlacionActual(): string | undefined {
  return almacenCorrelacion.getStore();
}

export async function conSpan<T>(
  nombre: string,
  atributos: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  return trace.getTracer('core-nestjs').startActiveSpan(nombre, async (span) => {
    span.setAttributes(atributos);
    const correlacion = almacenCorrelacion.getStore();
    if (correlacion !== undefined) span.setAttribute('correlation_id', correlacion);
    try {
      return await fn();
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
