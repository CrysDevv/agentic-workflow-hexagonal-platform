// Fábrica de la aplicación HTTP real (controladores, guards, filtro RFC 7807) con puertos en memoria.
import 'reflect-metadata';
import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import { ConsultasCasoUso, IniciarEjecucionCasoUso, ResolverAprobacionCasoUso } from '../application/use-cases';
import { TOKENS, cargarConfig } from '../config/config';
import type { LlmPuerto } from '../domain/ports';
import {
  AprobacionesControlador,
  AuthControlador,
  EjecucionesControlador,
  MetricasControlador,
  SaludControlador,
  WebhooksControlador,
} from '../infrastructure/http/controllers';
import {
  FiltroProblemas,
  ServicioMetricas,
  crearMiddlewareMetricas,
  middlewareCorrelacion,
} from '../infrastructure/http/http-support';
import { RegistroClavesApi, VerificadorWebhook } from '../infrastructure/security/security';
import { PoolFalso, RedisFalso, crearEntorno, type Entorno } from './fakes';

export const CLAVES_PRUEBA = {
  admin: 'clave-admin-de-pruebas-0123456789',
  aprobador: 'clave-aprobador-de-pruebas-0123456789',
} as const;

export const SECRETO_WEBHOOK = 'w'.repeat(40);

export interface AppPrueba {
  readonly app: NestExpressApplication;
  readonly env: Entorno;
  readonly redis: RedisFalso;
  readonly pool: PoolFalso;
  readonly metricas: ServicioMetricas;
}

export async function construirApp(opciones: { llm?: LlmPuerto; rateLimitMax?: number } = {}): Promise<AppPrueba> {
  const env = crearEntorno({ llm: opciones.llm });
  const cfg = cargarConfig({
    JWT_SECRET: 'j'.repeat(40),
    WEBHOOK_HMAC_SECRET: SECRETO_WEBHOOK,
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    S3_BUCKET: 'bucket',
    API_KEYS: `admin:ADMIN:${CLAVES_PRUEBA.admin},aprobador:APROBADOR:${CLAVES_PRUEBA.aprobador}`,
    RATE_LIMIT_MAX: String(opciones.rateLimitMax ?? 1000),
  });
  const redis = new RedisFalso();
  const pool = new PoolFalso();
  const metricas = new ServicioMetricas();
  const jwt = new JwtService({
    secret: cfg.jwt.secret,
    signOptions: { expiresIn: cfg.jwt.expiresIn, algorithm: 'HS256' },
    verifyOptions: { algorithms: ['HS256'] },
  });

  const modulo = await Test.createTestingModule({
    controllers: [
      SaludControlador,
      MetricasControlador,
      AuthControlador,
      EjecucionesControlador,
      AprobacionesControlador,
      WebhooksControlador,
    ],
    providers: [
      { provide: TOKENS.CONFIG, useValue: cfg },
      { provide: TOKENS.POOL, useValue: pool },
      { provide: TOKENS.REDIS, useValue: redis as unknown as Redis },
      { provide: TOKENS.CLAVES, useValue: new RegistroClavesApi(cfg.apiKeys) },
      { provide: TOKENS.AUDITORIA, useValue: env.auditoria },
      { provide: JwtService, useValue: jwt },
      { provide: ServicioMetricas, useValue: metricas },
      { provide: VerificadorWebhook, useValue: new VerificadorWebhook(cfg.webhookSecret, redis as unknown as Redis) },
      { provide: IniciarEjecucionCasoUso, useValue: env.iniciar },
      { provide: ConsultasCasoUso, useValue: env.consultas },
      { provide: ResolverAprobacionCasoUso, useValue: env.resolver },
    ],
  }).compile();

  const app = modulo.createNestApplication<NestExpressApplication>({ rawBody: true });
  app.use(middlewareCorrelacion);
  app.use(crearMiddlewareMetricas(metricas));
  app.useGlobalFilters(new FiltroProblemas(metricas));
  await app.init();
  return { app, env, redis, pool, metricas };
}
