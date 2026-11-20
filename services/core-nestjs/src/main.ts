import 'reflect-metadata';
import type { LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { cargarConfig } from './config/config';
import { FiltroProblemas, ServicioMetricas, crearMiddlewareMetricas, middlewareCorrelacion } from './infrastructure/http/http-support';

function nivelesLog(nivel: string): LogLevel[] {
  const orden: LogLevel[] = ['error', 'warn', 'log', 'debug', 'verbose'];
  const mapa: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3, verbose: 4 };
  const limite = mapa[nivel] ?? 2;
  return orden.slice(0, limite + 1);
}

async function arrancar(): Promise<void> {
  const cfg = cargarConfig();

  const sdk = new NodeSDK({
    serviceName: cfg.otel.serviceName,
    traceExporter: new OTLPTraceExporter({ url: `${cfg.otel.endpoint}/v1/traces` }),
  });
  sdk.start();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: nivelesLog(cfg.logLevel),
  });

  app.disable('x-powered-by');
  app.set('trust proxy', Number.parseInt(process.env['TRUST_PROXY_HOPS'] ?? '1', 10) || 1);
  app.use(helmet());
  app.use(middlewareCorrelacion);

  const metricas = app.get(ServicioMetricas);
  app.use(crearMiddlewareMetricas(metricas));
  app.useGlobalFilters(new FiltroProblemas(metricas));

  app.enableCors({
    origin: [...cfg.corsOrigins],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Correlation-ID', 'X-Signature', 'X-Timestamp'],
    exposedHeaders: ['X-Correlation-ID', 'Retry-After', 'X-RateLimit-Remaining'],
    maxAge: 600,
  });

  app.enableShutdownHooks();
  process.once('SIGTERM', () => {
    void sdk.shutdown();
  });

  await app.listen(cfg.port, '0.0.0.0');
}

arrancar().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Fallo crítico al iniciar core-nestjs:', error);
  process.exit(1);
});
