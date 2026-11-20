import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req, UseGuards } from '@nestjs/common';
import { TOKENS } from '../../config/config';
import type { AuditoriaPuerto } from '../../domain/ports';
import {
  ServicioConfigLlm,
  parsearCambio,
  type ResultadoPrueba,
  type VistaConfigLlm,
} from '../llm/llm-router';
import { AutenticacionGuard, LimitadorTasaGuard, Roles, type SolicitudApp } from '../security/security';

/** Selección del proveedor de IA desde la consola. Solo ADMIN puede modificar; la API Key nunca se devuelve. */
@Controller('configuracion/llm')
@UseGuards(LimitadorTasaGuard, AutenticacionGuard)
export class ConfiguracionLlmControlador {
  constructor(
    private readonly servicio: ServicioConfigLlm,
    @Inject(TOKENS.AUDITORIA) private readonly auditoria: AuditoriaPuerto,
  ) {}

  @Get()
  vista(): Promise<VistaConfigLlm> {
    return this.servicio.vista();
  }

  @Get('ollama/modelos')
  @Roles('ADMIN')
  modelos(@Query('baseUrl') baseUrl?: string): Promise<ResultadoPrueba> {
    return this.servicio.modelosOllama(baseUrl);
  }

  @Post('probar')
  @Roles('ADMIN')
  @HttpCode(200)
  probar(@Body() cuerpo: unknown): Promise<ResultadoPrueba> {
    return this.servicio.probar(parsearCambio(cuerpo));
  }

  @Post()
  @Roles('ADMIN')
  @HttpCode(200)
  async actualizar(@Body() cuerpo: unknown, @Req() req: SolicitudApp): Promise<VistaConfigLlm> {
    const cambio = parsearCambio(cuerpo);
    const vista = await this.servicio.actualizar(cambio);
    await this.auditoria.registrar({
      tipoEvento: 'CONFIG_LLM_CAMBIADA',
      severidad: 'WARN',
      actor: req.principal?.nombre ?? null,
      ipOrigen: req.ip ?? null,
      correlationId: req.correlationId ?? null,
      detalle: {
        proveedor: vista.proveedor,
        anthropicModel: vista.anthropicModel,
        ollamaBaseUrl: vista.ollamaBaseUrl,
        ollamaModel: vista.ollamaModel,
        claveActualizada: cambio.anthropicApiKey !== undefined,
        claveEliminada: cambio.borrarAnthropicKey === true,
      },
    });
    return vista;
  }
}
