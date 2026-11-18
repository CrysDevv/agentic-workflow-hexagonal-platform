import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Response } from 'express';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import {
  ConsultasCasoUso,
  IniciarEjecucionCasoUso,
  ResolverAprobacionCasoUso,
  type TrazaEjecucion,
} from '../../application/use-cases';
import { exigirObjeto, exigirTexto, textoOpcional } from '../../application/tools/tool-registry';
import {
  ErrorValidacion,
  type AprobacionProps,
  type EjecucionProps,
  type JsonObjeto,
} from '../../domain/entities';
import type { AuditoriaPuerto } from '../../domain/ports';
import { TOKENS, conSpan, type AppConfig } from '../../config/config';
import {
  AutenticacionGuard,
  LimitadorTasaGuard,
  RegistroClavesApi,
  Roles,
  VerificadorWebhook,
  type SolicitudApp,
} from '../security/security';
import { ServicioMetricas } from './http-support';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATRON_FLUJO = /^[a-z0-9][a-z0-9-]{0,118}$/;

function exigirUuid(valor: string, campo: string): string {
  if (!UUID.test(valor)) {
    throw new ErrorValidacion(`'${campo}' debe ser un UUID válido`, { campo });
  }
  return valor;
}

function limiteDe(valor: string | undefined): number {
  const n = Number.parseInt(valor ?? '', 10);
  return Number.isInteger(n) ? n : 50;
}

// ============================== Salud ==============================
@Controller()
export class SaludControlador {
  constructor(
    @Inject(TOKENS.POOL) private readonly pool: Pool,
    @Inject(TOKENS.REDIS) private readonly redis: Redis,
  ) {}

  @Get('health')
  async salud(): Promise<{ status: string; db: string; redis: string }> {
    try {
      await this.pool.query('SELECT 1');
      await this.redis.ping();
    } catch {
      throw new ServiceUnavailableException('Las dependencias no están disponibles');
    }
    return { status: 'ok', db: 'ok', redis: 'ok' };
  }
}

// ============================== Métricas ==============================
@Controller()
export class MetricasControlador {
  constructor(private readonly metricas: ServicioMetricas) {}

  @Get('metrics')
  async exponer(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', this.metricas.registro.contentType);
    res.send(await this.metricas.registro.metrics());
  }
}

// ============================== Autenticación ==============================
@Controller('auth')
@UseGuards(LimitadorTasaGuard)
export class AuthControlador {
  constructor(
    @Inject(TOKENS.CLAVES) private readonly claves: RegistroClavesApi,
    @Inject(TOKENS.CONFIG) private readonly cfg: AppConfig,
    @Inject(TOKENS.AUDITORIA) private readonly auditoria: AuditoriaPuerto,
    private readonly jwt: JwtService,
  ) {}

  @Post('token')
  @HttpCode(200)
  async emitir(
    @Req() req: SolicitudApp,
  ): Promise<{ access_token: string; token_type: string; expires_in: string; usuario: string; rol: string }> {
    const clave = req.header('x-api-key');
    const principal = typeof clave === 'string' && clave.length <= 256 ? this.claves.validar(clave) : null;
    if (principal === null) {
      await this.auditoria.registrar({
        tipoEvento: 'AUTENTICACION_FALLIDA',
        severidad: 'WARN',
        actor: null,
        ipOrigen: req.ip ?? null,
        correlationId: req.correlationId ?? null,
        detalle: { ruta: '/auth/token' },
      });
      throw new UnauthorizedException('Credenciales ausentes o inválidas');
    }
    const token = await this.jwt.signAsync({ sub: principal.nombre, rol: principal.rol });
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: this.cfg.jwt.expiresIn,
      usuario: principal.nombre,
      rol: principal.rol,
    };
  }
}

// ============================== Ejecuciones ==============================
@Controller('ejecuciones')
@UseGuards(LimitadorTasaGuard, AutenticacionGuard)
export class EjecucionesControlador {
  constructor(
    private readonly iniciar: IniciarEjecucionCasoUso,
    private readonly consultas: ConsultasCasoUso,
  ) {}

  @Post()
  @HttpCode(202)
  async crear(@Body() cuerpo: unknown, @Req() req: SolicitudApp): Promise<EjecucionProps> {
    const o = exigirObjeto(cuerpo, 'cuerpo');
    const flujoNombre = exigirTexto(o['flujo'], 'flujo', 120);
    const entrada = exigirObjeto(o['entrada'] ?? {}, 'entrada') as JsonObjeto;
    return conSpan('api.iniciar_ejecucion', { flujo: flujoNombre }, () =>
      this.iniciar.ejecutar({
        flujoNombre,
        entrada,
        origen: 'API',
        correlationId: req.correlationId ?? 'sin-correlacion',
        actor: req.principal?.nombre,
        ipOrigen: req.ip,
      }),
    );
  }

  @Get()
  listar(@Query('limite') limite?: string): Promise<EjecucionProps[]> {
    return this.consultas.listarEjecuciones(limiteDe(limite));
  }

  @Get(':id/traza')
  traza(@Param('id') id: string): Promise<TrazaEjecucion> {
    return this.consultas.obtenerTraza(exigirUuid(id, 'id'));
  }
}

// ============================== Aprobaciones (Human-in-the-Loop) ==============================
@Controller('aprobaciones')
@UseGuards(LimitadorTasaGuard, AutenticacionGuard)
export class AprobacionesControlador {
  constructor(
    private readonly resolverCaso: ResolverAprobacionCasoUso,
    private readonly consultas: ConsultasCasoUso,
    private readonly metricas: ServicioMetricas,
  ) {}

  @Get('pendientes')
  pendientes(@Query('limite') limite?: string): Promise<AprobacionProps[]> {
    return this.consultas.listarAprobacionesPendientes(limiteDe(limite));
  }

  @Post(':id/resolver')
  @Roles('APROBADOR', 'ADMIN')
  @HttpCode(200)
  async resolver(
    @Param('id') id: string,
    @Body() cuerpo: unknown,
    @Req() req: SolicitudApp,
  ): Promise<EjecucionProps> {
    const aprobacionId = exigirUuid(id, 'id');
    const o = exigirObjeto(cuerpo, 'cuerpo');
    const decision = o['decision'];
    if (decision !== 'APROBAR' && decision !== 'RECHAZAR') {
      throw new ErrorValidacion("'decision' debe ser APROBAR o RECHAZAR", { campo: 'decision' });
    }
    const comentario = textoOpcional(o['comentario'], 'comentario', 1000);
    const principal = req.principal;
    if (principal === undefined) throw new UnauthorizedException('Credenciales ausentes o inválidas');

    const ejecucion = await conSpan('api.resolver_aprobacion', { decision }, () =>
      this.resolverCaso.ejecutar({ aprobacionId, decision, usuario: principal.nombre, comentario }),
    );
    this.metricas.aprobacionResuelta(decision);
    this.metricas.ejecucionFinalizada(ejecucion.estado);
    return ejecucion;
  }
}

// ============================== Webhooks firmados ==============================
@Controller('webhooks')
export class WebhooksControlador {
  constructor(
    private readonly iniciar: IniciarEjecucionCasoUso,
    private readonly verificador: VerificadorWebhook,
    private readonly metricas: ServicioMetricas,
    @Inject(TOKENS.AUDITORIA) private readonly auditoria: AuditoriaPuerto,
  ) {}

  /** Utilidad del Simulador: firma un cuerpo con el secreto del servidor (solo ADMIN). */
  @Post('simulador/firmar')
  @UseGuards(LimitadorTasaGuard, AutenticacionGuard)
  @Roles('ADMIN')
  @HttpCode(200)
  firmar(@Body() cuerpo: unknown): { timestamp: string; firma: string; cuerpoCanonico: string } {
    const o = exigirObjeto(cuerpo, 'cuerpo');
    const contenido = exigirObjeto(o['cuerpo'], 'cuerpo.cuerpo');
    const cuerpoCanonico = JSON.stringify(contenido);
    const timestamp = String(Math.floor(Date.now() / 1000));
    return { timestamp, firma: this.verificador.generarFirma(timestamp, Buffer.from(cuerpoCanonico, 'utf8')), cuerpoCanonico };
  }

  @Post(':flujo')
  @UseGuards(LimitadorTasaGuard)
  @HttpCode(202)
  async recibir(
    @Param('flujo') flujo: string,
    @Body() cuerpo: unknown,
    @Req() req: SolicitudApp,
  ): Promise<EjecucionProps> {
    if (!PATRON_FLUJO.test(flujo)) {
      throw new ErrorValidacion('Nombre de flujo inválido', { campo: 'flujo' });
    }
    const crudo = req.rawBody;
    const veredicto =
      crudo === undefined
        ? ({ valido: false, motivo: 'Cuerpo ausente' } as const)
        : await this.verificador.verificar(crudo, req.header('x-signature'), req.header('x-timestamp'));

    if (!veredicto.valido) {
      this.metricas.webhookRecibido('rechazado');
      await this.auditoria.registrar({
        tipoEvento: 'WEBHOOK_FIRMA_INVALIDA',
        severidad: 'ALTA',
        actor: 'webhook',
        ipOrigen: req.ip ?? null,
        correlationId: req.correlationId ?? null,
        detalle: { flujo, motivo: veredicto.motivo },
      });
      throw new UnauthorizedException('Firma de webhook inválida');
    }
    this.metricas.webhookRecibido('aceptado');

    const entrada = exigirObjeto(cuerpo, 'cuerpo') as JsonObjeto;
    return conSpan('api.webhook_recibido', { flujo }, () =>
      this.iniciar.ejecutar({
        flujoNombre: flujo,
        entrada,
        origen: 'WEBHOOK',
        correlationId: req.correlationId ?? 'sin-correlacion',
        actor: 'webhook',
        ipOrigen: req.ip,
      }),
    );
  }
}
