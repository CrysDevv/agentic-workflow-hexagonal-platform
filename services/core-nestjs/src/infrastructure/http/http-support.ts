import { randomUUID } from 'node:crypto';
import {
  Catch,
  HttpException,
  Injectable,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import {
  ErrorDominio,
  ErrorInyeccionPrompt,
  ErrorNoEncontrado,
  ErrorTransicionInvalida,
  ErrorValidacion,
} from '../../domain/entities';
import { almacenCorrelacion } from '../../config/config';
import type { SolicitudApp } from '../security/security';

// ============================== X-Correlation-ID ==============================
const PATRON_CORRELACION = /^[A-Za-z0-9._-]{8,64}$/;

export function middlewareCorrelacion(req: Request, res: Response, next: NextFunction): void {
  const entrante = req.header('x-correlation-id');
  const id = typeof entrante === 'string' && PATRON_CORRELACION.test(entrante) ? entrante : randomUUID();
  (req as SolicitudApp).correlationId = id;
  res.setHeader('X-Correlation-ID', id);
  almacenCorrelacion.run(id, next);
}

// ============================== Métricas Prometheus ==============================
@Injectable()
export class ServicioMetricas {
  readonly registro = new Registry();

  private readonly solicitudes = new Counter<'metodo' | 'ruta' | 'estado'>({
    name: 'http_requests_total',
    help: 'Total de solicitudes HTTP',
    labelNames: ['metodo', 'ruta', 'estado'],
    registers: [this.registro],
  });

  private readonly duracion = new Histogram<'metodo' | 'ruta'>({
    name: 'http_request_duration_seconds',
    help: 'Duración de solicitudes HTTP en segundos',
    labelNames: ['metodo', 'ruta'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registro],
  });

  private readonly ejecuciones = new Counter<'estado'>({
    name: 'agent_executions_total',
    help: 'Ejecuciones del agente por estado resultante',
    labelNames: ['estado'],
    registers: [this.registro],
  });

  private readonly aprobaciones = new Counter<'decision'>({
    name: 'agent_approvals_total',
    help: 'Aprobaciones humanas resueltas',
    labelNames: ['decision'],
    registers: [this.registro],
  });

  private readonly bloqueosGuardrail = new Counter({
    name: 'guardrail_blocks_total',
    help: 'Solicitudes bloqueadas por el guardrail anti-prompt-injection',
    registers: [this.registro],
  });

  private readonly webhooks = new Counter<'resultado'>({
    name: 'webhooks_total',
    help: 'Webhooks recibidos por resultado de verificación',
    labelNames: ['resultado'],
    registers: [this.registro],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registro });
  }

  registrarSolicitud(metodo: string, ruta: string, estado: string, segundos: number): void {
    this.solicitudes.inc({ metodo, ruta, estado });
    this.duracion.observe({ metodo, ruta }, segundos);
  }

  ejecucionFinalizada(estado: string): void {
    this.ejecuciones.inc({ estado });
  }

  aprobacionResuelta(decision: string): void {
    this.aprobaciones.inc({ decision });
  }

  guardrailBloqueo(): void {
    this.bloqueosGuardrail.inc();
  }

  webhookRecibido(resultado: 'aceptado' | 'rechazado'): void {
    this.webhooks.inc({ resultado });
  }
}

export function crearMiddlewareMetricas(servicio: ServicioMetricas): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const inicio = process.hrtime.bigint();
    res.on('finish', () => {
      const segundos = Number(process.hrtime.bigint() - inicio) / 1e9;
      const ruta =
        typeof req.route?.path === 'string' ? `${req.baseUrl}${String(req.route.path)}` : 'no_enrutada';
      servicio.registrarSolicitud(req.method, ruta, String(res.statusCode), segundos);
    });
    next();
  };
}

// ============================== Filtro RFC 7807 (application/problem+json) ==============================
interface Problema {
  readonly status: number;
  readonly tipo: string;
  readonly titulo: string;
  readonly detalle: string;
  readonly extension: Record<string, unknown>;
}

const TITULOS: Readonly<Record<number, string>> = {
  400: 'Solicitud inválida',
  401: 'No autenticado',
  403: 'Acceso denegado',
  404: 'Recurso no encontrado',
  409: 'Conflicto de estado',
  413: 'Carga demasiado grande',
  415: 'Tipo de contenido no soportado',
  422: 'Entidad no procesable',
  429: 'Demasiadas solicitudes',
  503: 'Servicio no disponible',
};

@Catch()
export class FiltroProblemas implements ExceptionFilter {
  private readonly log = new Logger('Problemas');

  constructor(private readonly metricas: ServicioMetricas) {}

  catch(excepcion: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<SolicitudApp>();
    const res = http.getResponse<Response>();
    if (res.headersSent) return;

    const problema = this.mapear(excepcion);
    if (problema.status >= 500) {
      this.log.error(
        `${req.method} ${req.path} -> ${problema.status} [${req.correlationId ?? 'sin-correlacion'}]`,
        excepcion instanceof Error ? excepcion.stack : undefined,
      );
    }

    const cuerpo = {
      type: `urn:agentic:problema:${problema.tipo}`,
      title: problema.titulo,
      status: problema.status,
      detail: problema.detalle,
      instance: req.originalUrl.split('?')[0],
      correlationId: req.correlationId ?? null,
      ...problema.extension,
    };
    res.status(problema.status);
    res.setHeader('Content-Type', 'application/problem+json');
    res.send(JSON.stringify(cuerpo));
  }

  private mapear(e: unknown): Problema {
    if (e instanceof ErrorInyeccionPrompt) {
      this.metricas.guardrailBloqueo();
      return {
        status: 422,
        tipo: 'prompt-injection',
        titulo: 'Contenido bloqueado por seguridad',
        detalle: e.message,
        extension: { reglas: e.detalle['reglas'], puntaje: e.detalle['puntaje'] },
      };
    }
    if (e instanceof ErrorValidacion) {
      const campo = e.detalle['campo'];
      return {
        status: 400,
        tipo: 'validacion',
        titulo: TITULOS[400] as string,
        detalle: e.message,
        extension: typeof campo === 'string' ? { campo } : {},
      };
    }
    if (e instanceof ErrorNoEncontrado) {
      return { status: 404, tipo: 'no-encontrado', titulo: TITULOS[404] as string, detalle: e.message, extension: {} };
    }
    if (e instanceof ErrorTransicionInvalida) {
      return { status: 409, tipo: 'conflicto', titulo: TITULOS[409] as string, detalle: e.message, extension: {} };
    }
    if (e instanceof ErrorDominio) {
      return { status: 422, tipo: 'regla-de-negocio', titulo: TITULOS[422] as string, detalle: e.message, extension: {} };
    }
    if (e instanceof HttpException) {
      const status = e.getStatus();
      const respuesta = e.getResponse();
      let detalle = e.message;
      if (typeof respuesta === 'string') {
        detalle = respuesta;
      } else if (typeof respuesta === 'object' && respuesta !== null) {
        const mensaje = (respuesta as Record<string, unknown>)['message'];
        if (typeof mensaje === 'string') detalle = mensaje;
        else if (Array.isArray(mensaje)) detalle = mensaje.map(String).join('; ');
      }
      return { status, tipo: `http-${status}`, titulo: TITULOS[status] ?? 'Error HTTP', detalle, extension: {} };
    }
    if (typeof e === 'object' && e !== null) {
      const candidato = (e as Record<string, unknown>)['status'] ?? (e as Record<string, unknown>)['statusCode'];
      if (typeof candidato === 'number' && candidato >= 400 && candidato < 500) {
        return {
          status: candidato,
          tipo: `http-${candidato}`,
          titulo: TITULOS[candidato] ?? 'Error de solicitud',
          detalle: candidato === 413 ? 'El cuerpo excede el tamaño permitido' : 'La solicitud no pudo ser procesada',
          extension: {},
        };
      }
    }
    return {
      status: 500,
      tipo: 'error-interno',
      titulo: 'Error interno del servidor',
      detalle: 'Ocurrió un error inesperado',
      extension: {},
    };
  }
}
