import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { MotorAgente } from './application/agent/agent-engine';
import { GuardrailPromptInjection } from './application/guardrails/prompt-injection.guardrail';
import { crearRegistroHerramientas } from './application/tools/herramientas-comerciales';
import { RegistroHerramientas } from './application/tools/tool-registry';
import {
  ConsultasCasoUso,
  IniciarEjecucionCasoUso,
  ProcesarEjecucionCasoUso,
  ResolverAprobacionCasoUso,
} from './application/use-cases';
import { TOKENS, cargarConfig, type AppConfig } from './config/config';
import type {
  AlmacenPropuestasPuerto,
  AprobacionRepositorio,
  AuditoriaPuerto,
  CatalogoProveedoresRepositorio,
  EjecucionRepositorio,
  FlujoRepositorio,
  GeneradorIdPuerto,
  LlmPuerto,
  NotificadorPuerto,
  PasoRepositorio,
  RelojPuerto,
} from './domain/ports';
import {
  AprobacionesControlador,
  AuthControlador,
  EjecucionesControlador,
  MetricasControlador,
  SaludControlador,
  WebhooksControlador,
} from './infrastructure/http/controllers';
import { ServicioMetricas } from './infrastructure/http/http-support';
import { LlmDinamico, RedisAlmacenConfigLlm, ServicioConfigLlm } from './infrastructure/llm/llm-router';
import { ConfiguracionLlmControlador } from './infrastructure/http/configuracion.controller';
import {
  AlmacenS3,
  GeneradorUuid,
  NotificadorOutboxS3,
  RedisCola,
  RelojSistema,
  SqsCola,
  TrabajadorCola,
  type ColaCompleta,
  type FuenteTareas,
} from './infrastructure/messaging/messaging.adapters';
import {
  AprobacionPostgres,
  AuditoriaPostgres,
  CatalogoPostgres,
  EjecucionPostgres,
  FlujoPostgres,
  PasoPostgres,
} from './infrastructure/persistence/postgres.adapters';
import { RegistroClavesApi, VerificadorWebhook } from './infrastructure/security/security';

@Injectable()
export class CierreRecursos implements OnApplicationShutdown {
  constructor(
    @Inject(TOKENS.POOL) private readonly pool: Pool,
    @Inject(TOKENS.REDIS) private readonly redis: Redis,
    private readonly trabajador: TrabajadorCola,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.trabajador.detener();
    await Promise.allSettled([this.pool.end(), this.redis.quit()]);
  }
}

@Module({
  controllers: [
    SaludControlador,
    MetricasControlador,
    AuthControlador,
    EjecucionesControlador,
    AprobacionesControlador,
    WebhooksControlador,
    ConfiguracionLlmControlador,
  ],
  providers: [
    ServicioMetricas,
    CierreRecursos,

    // ---------- Configuración e infraestructura base ----------
    { provide: TOKENS.CONFIG, useFactory: (): AppConfig => cargarConfig() },
    {
      provide: TOKENS.POOL,
      inject: [TOKENS.CONFIG],
      useFactory: (cfg: AppConfig): Pool => {
        const pool = new Pool({ connectionString: cfg.databaseUrl, max: 10, idleTimeoutMillis: 30_000 });
        const log = new Logger('Postgres');
        pool.on('error', (error) => log.error(`Error en cliente inactivo: ${error.message}`));
        return pool;
      },
    },
    {
      provide: TOKENS.REDIS,
      inject: [TOKENS.CONFIG],
      useFactory: (cfg: AppConfig): Redis => {
        const redis = new Redis(cfg.redisUrl, { maxRetriesPerRequest: 3 });
        const log = new Logger('Redis');
        redis.on('error', (error: Error) => log.error(`Error de conexión: ${error.message}`));
        return redis;
      },
    },
    {
      provide: TOKENS.S3,
      inject: [TOKENS.CONFIG],
      useFactory: (cfg: AppConfig): S3Client =>
        new S3Client({
          region: cfg.aws.region,
          endpoint: cfg.aws.endpoint,
          forcePathStyle: cfg.aws.endpoint !== undefined,
          credentials: { accessKeyId: cfg.aws.accessKeyId, secretAccessKey: cfg.aws.secretAccessKey },
        }),
    },
    {
      provide: TOKENS.SQS,
      inject: [TOKENS.CONFIG],
      useFactory: (cfg: AppConfig): SQSClient =>
        new SQSClient({
          region: cfg.aws.region,
          endpoint: cfg.aws.endpoint,
          credentials: { accessKeyId: cfg.aws.accessKeyId, secretAccessKey: cfg.aws.secretAccessKey },
        }),
    },
    { provide: TOKENS.RELOJ, useFactory: (): RelojPuerto => new RelojSistema() },
    { provide: TOKENS.IDS, useFactory: (): GeneradorIdPuerto => new GeneradorUuid() },

    // ---------- Persistencia ----------
    { provide: TOKENS.FLUJOS, inject: [TOKENS.POOL], useFactory: (p: Pool): FlujoRepositorio => new FlujoPostgres(p) },
    {
      provide: TOKENS.EJECUCIONES,
      inject: [TOKENS.POOL],
      useFactory: (p: Pool): EjecucionRepositorio => new EjecucionPostgres(p),
    },
    { provide: TOKENS.PASOS, inject: [TOKENS.POOL], useFactory: (p: Pool): PasoRepositorio => new PasoPostgres(p) },
    {
      provide: TOKENS.APROBACIONES,
      inject: [TOKENS.POOL],
      useFactory: (p: Pool): AprobacionRepositorio => new AprobacionPostgres(p),
    },
    {
      provide: TOKENS.CATALOGO,
      inject: [TOKENS.POOL],
      useFactory: (p: Pool): CatalogoProveedoresRepositorio => new CatalogoPostgres(p),
    },
    {
      provide: TOKENS.AUDITORIA,
      inject: [TOKENS.POOL],
      useFactory: (p: Pool): AuditoriaPuerto => new AuditoriaPostgres(p),
    },

    // ---------- Almacenamiento, notificaciones y colas ----------
    {
      provide: TOKENS.ALMACEN,
      inject: [TOKENS.S3, TOKENS.CONFIG],
      useFactory: (s3: S3Client, cfg: AppConfig): AlmacenPropuestasPuerto => new AlmacenS3(s3, cfg.aws.bucket),
    },
    {
      provide: TOKENS.NOTIFICADOR,
      inject: [TOKENS.ALMACEN, TOKENS.IDS, TOKENS.RELOJ],
      useFactory: (a: AlmacenPropuestasPuerto, ids: GeneradorIdPuerto, r: RelojPuerto): NotificadorPuerto =>
        new NotificadorOutboxS3(a, ids, r),
    },
    {
      provide: TOKENS.COLA,
      inject: [TOKENS.CONFIG, TOKENS.REDIS, TOKENS.SQS],
      useFactory: (cfg: AppConfig, redis: Redis, sqs: SQSClient): ColaCompleta =>
        cfg.queue.driver === 'sqs' ? new SqsCola(sqs, cfg.queue.sqsQueueUrl) : new RedisCola(redis),
    },
    { provide: TOKENS.FUENTE, useExisting: TOKENS.COLA },

    // ---------- Configuración dinámica del LLM (seleccionable desde la consola) ----------
    {
      provide: ServicioConfigLlm,
      inject: [TOKENS.CONFIG, TOKENS.REDIS],
      useFactory: (cfg: AppConfig, redis: Redis): ServicioConfigLlm =>
        new ServicioConfigLlm(cfg.llm, new RedisAlmacenConfigLlm(redis), cfg.jwt.secret),
    },

    // ---------- Aplicación ----------
    { provide: GuardrailPromptInjection, useFactory: (): GuardrailPromptInjection => new GuardrailPromptInjection() },
    {
      provide: TOKENS.LLM,
      inject: [ServicioConfigLlm, GuardrailPromptInjection],
      useFactory: (servicio: ServicioConfigLlm, guardrail: GuardrailPromptInjection): LlmPuerto =>
        new LlmDinamico(servicio, guardrail),
    },
    {
      provide: RegistroHerramientas,
      inject: [
        TOKENS.CATALOGO,
        TOKENS.NOTIFICADOR,
        TOKENS.ALMACEN,
        TOKENS.IDS,
        TOKENS.RELOJ,
        TOKENS.EJECUCIONES,
        TOKENS.APROBACIONES,
        TOKENS.FLUJOS,
        TOKENS.AUDITORIA,
      ],
      useFactory: (
        catalogo: CatalogoProveedoresRepositorio,
        notificador: NotificadorPuerto,
        almacen: AlmacenPropuestasPuerto,
        ids: GeneradorIdPuerto,
        reloj: RelojPuerto,
        ejecuciones: EjecucionRepositorio,
        aprobaciones: AprobacionRepositorio,
        flujos: FlujoRepositorio,
        auditoria: AuditoriaPuerto,
      ): RegistroHerramientas =>
        crearRegistroHerramientas({
          catalogo,
          notificador,
          almacen,
          ids,
          reloj,
          ejecuciones,
          aprobaciones,
          flujos,
          auditoria,
        }),
    },
    {
      provide: MotorAgente,
      inject: [
        TOKENS.EJECUCIONES,
        TOKENS.PASOS,
        TOKENS.APROBACIONES,
        TOKENS.FLUJOS,
        TOKENS.LLM,
        RegistroHerramientas,
        GuardrailPromptInjection,
        TOKENS.AUDITORIA,
        TOKENS.RELOJ,
        TOKENS.IDS,
      ],
      useFactory: (
        ejecuciones: EjecucionRepositorio,
        pasos: PasoRepositorio,
        aprobaciones: AprobacionRepositorio,
        flujos: FlujoRepositorio,
        llm: LlmPuerto,
        herramientas: RegistroHerramientas,
        guardrail: GuardrailPromptInjection,
        auditoria: AuditoriaPuerto,
        reloj: RelojPuerto,
        ids: GeneradorIdPuerto,
      ): MotorAgente =>
        new MotorAgente({ ejecuciones, pasos, aprobaciones, flujos, llm, herramientas, guardrail, auditoria, reloj, ids }),
    },
    {
      provide: IniciarEjecucionCasoUso,
      inject: [
        TOKENS.FLUJOS,
        TOKENS.EJECUCIONES,
        TOKENS.COLA,
        GuardrailPromptInjection,
        TOKENS.AUDITORIA,
        TOKENS.RELOJ,
        TOKENS.IDS,
      ],
      useFactory: (
        flujos: FlujoRepositorio,
        ejecuciones: EjecucionRepositorio,
        cola: ColaCompleta,
        guardrail: GuardrailPromptInjection,
        auditoria: AuditoriaPuerto,
        reloj: RelojPuerto,
        ids: GeneradorIdPuerto,
      ): IniciarEjecucionCasoUso =>
        new IniciarEjecucionCasoUso(flujos, ejecuciones, cola, guardrail, auditoria, reloj, ids),
    },
    {
      provide: ProcesarEjecucionCasoUso,
      inject: [MotorAgente],
      useFactory: (motor: MotorAgente): ProcesarEjecucionCasoUso => new ProcesarEjecucionCasoUso(motor),
    },
    {
      provide: ResolverAprobacionCasoUso,
      inject: [TOKENS.APROBACIONES, MotorAgente, TOKENS.AUDITORIA, TOKENS.RELOJ],
      useFactory: (
        aprobaciones: AprobacionRepositorio,
        motor: MotorAgente,
        auditoria: AuditoriaPuerto,
        reloj: RelojPuerto,
      ): ResolverAprobacionCasoUso => new ResolverAprobacionCasoUso(aprobaciones, motor, auditoria, reloj),
    },
    {
      provide: ConsultasCasoUso,
      inject: [TOKENS.EJECUCIONES, TOKENS.PASOS, TOKENS.APROBACIONES],
      useFactory: (
        ejecuciones: EjecucionRepositorio,
        pasos: PasoRepositorio,
        aprobaciones: AprobacionRepositorio,
      ): ConsultasCasoUso => new ConsultasCasoUso(ejecuciones, pasos, aprobaciones),
    },
    {
      provide: TrabajadorCola,
      inject: [TOKENS.FUENTE, ProcesarEjecucionCasoUso, ServicioMetricas],
      useFactory: (fuente: FuenteTareas, caso: ProcesarEjecucionCasoUso, metricas: ServicioMetricas): TrabajadorCola =>
        new TrabajadorCola(fuente, caso, (ejecucion) => metricas.ejecucionFinalizada(ejecucion.estado)),
    },

    // ---------- Seguridad ----------
    {
      provide: TOKENS.CLAVES,
      inject: [TOKENS.CONFIG],
      useFactory: (cfg: AppConfig): RegistroClavesApi => new RegistroClavesApi(cfg.apiKeys),
    },
    {
      provide: JwtService,
      inject: [TOKENS.CONFIG],
      useFactory: (cfg: AppConfig): JwtService =>
        new JwtService({
          secret: cfg.jwt.secret,
          signOptions: { expiresIn: cfg.jwt.expiresIn, algorithm: 'HS256' },
          verifyOptions: { algorithms: ['HS256'] },
        }),
    },
    {
      provide: VerificadorWebhook,
      inject: [TOKENS.CONFIG, TOKENS.REDIS],
      useFactory: (cfg: AppConfig, redis: Redis): VerificadorWebhook => new VerificadorWebhook(cfg.webhookSecret, redis),
    },
  ],
})
export class AppModule {}
