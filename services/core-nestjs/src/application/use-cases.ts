import {
  EjecucionAgente,
  ErrorInyeccionPrompt,
  ErrorNoEncontrado,
  ErrorValidacion,
  type AprobacionProps,
  type EjecucionProps,
  type JsonObjeto,
  type OrigenEjecucion,
  type PasoProps,
} from '../domain/entities';
import type {
  AprobacionRepositorio,
  AuditoriaPuerto,
  ColaTareasPuerto,
  EjecucionRepositorio,
  FlujoRepositorio,
  GeneradorIdPuerto,
  PasoRepositorio,
  RelojPuerto,
} from '../domain/ports';
import type { MotorAgente } from './agent/agent-engine';
import type { GuardrailPromptInjection } from './guardrails/prompt-injection.guardrail';
import { exigirTexto, textoOpcional } from './tools/tool-registry';

// ============================== Iniciar ejecución ==============================
export interface IniciarEjecucionComando {
  readonly flujoNombre: string;
  readonly entrada: JsonObjeto;
  readonly origen: OrigenEjecucion;
  readonly correlationId: string;
  readonly actor?: string;
  readonly ipOrigen?: string;
}

export class IniciarEjecucionCasoUso {
  constructor(
    private readonly flujos: FlujoRepositorio,
    private readonly ejecuciones: EjecucionRepositorio,
    private readonly cola: ColaTareasPuerto,
    private readonly guardrail: GuardrailPromptInjection,
    private readonly auditoria: AuditoriaPuerto,
    private readonly reloj: RelojPuerto,
    private readonly ids: GeneradorIdPuerto,
  ) {}

  async ejecutar(comando: IniciarEjecucionComando): Promise<EjecucionProps> {
    const nombreFlujo = exigirTexto(comando.flujoNombre, 'flujo', 120);
    const flujo = await this.flujos.obtenerPorNombre(nombreFlujo);
    if (!flujo || !flujo.activo) {
      throw new ErrorNoEncontrado('flujo', nombreFlujo);
    }

    const analisis = this.guardrail.analizar(comando.entrada);
    if (analisis.bloqueado) {
      await this.auditoria.registrar({
        tipoEvento: 'PROMPT_INJECTION_BLOQUEADA',
        severidad: analisis.severidad,
        actor: comando.actor ?? null,
        ipOrigen: comando.ipOrigen ?? null,
        correlationId: comando.correlationId,
        detalle: { origen: 'INGRESO', flujo: flujo.nombre, puntaje: analisis.puntaje, reglas: [...analisis.reglas] },
      });
      throw new ErrorInyeccionPrompt('INGRESO', analisis.reglas, analisis.puntaje);
    }

    const ejecucion = EjecucionAgente.crear({
      id: this.ids.nuevo(),
      flujoId: flujo.id,
      origen: comando.origen,
      entrada: comando.entrada,
      correlationId: comando.correlationId,
      ahora: this.reloj.ahora(),
    });
    await this.ejecuciones.guardar(ejecucion);
    await this.cola.encolar(ejecucion.id, ejecucion.correlationId);
    await this.auditoria.registrar({
      tipoEvento: 'EJECUCION_CREADA',
      severidad: 'INFO',
      actor: comando.actor ?? null,
      ipOrigen: comando.ipOrigen ?? null,
      correlationId: comando.correlationId,
      detalle: { ejecucionId: ejecucion.id, flujo: flujo.nombre, origen: comando.origen },
    });
    return ejecucion.snapshot();
  }
}

// ============================== Procesar ejecución (consumidor de cola) ==============================
export class ProcesarEjecucionCasoUso {
  constructor(private readonly motor: MotorAgente) {}

  async ejecutar(ejecucionId: string): Promise<EjecucionProps> {
    const ejecucion = await this.motor.ejecutar(ejecucionId);
    return ejecucion.snapshot();
  }
}

// ============================== Resolver aprobación (Human-in-the-Loop) ==============================
export interface ResolverAprobacionComando {
  readonly aprobacionId: string;
  readonly decision: 'APROBAR' | 'RECHAZAR';
  readonly usuario: string;
  readonly comentario?: string;
}

export class ResolverAprobacionCasoUso {
  constructor(
    private readonly aprobaciones: AprobacionRepositorio,
    private readonly motor: MotorAgente,
    private readonly auditoria: AuditoriaPuerto,
    private readonly reloj: RelojPuerto,
  ) {}

  async ejecutar(comando: ResolverAprobacionComando): Promise<EjecucionProps> {
    const usuario = exigirTexto(comando.usuario, 'usuario', 120);
    if (comando.decision !== 'APROBAR' && comando.decision !== 'RECHAZAR') {
      throw new ErrorValidacion("'decision' debe ser APROBAR o RECHAZAR");
    }
    const comentario = textoOpcional(comando.comentario, 'comentario', 1000) ?? null;

    const aprobacion = await this.aprobaciones.obtenerPorId(comando.aprobacionId);
    if (!aprobacion) {
      throw new ErrorNoEncontrado('aprobacion', comando.aprobacionId);
    }

    const ahora = this.reloj.ahora();
    if (comando.decision === 'APROBAR') {
      aprobacion.aprobar(usuario, comentario, ahora);
    } else {
      aprobacion.rechazar(usuario, comentario, ahora);
    }
    await this.aprobaciones.guardar(aprobacion);
    await this.auditoria.registrar({
      tipoEvento: 'APROBACION_RESUELTA',
      severidad: 'INFO',
      actor: usuario,
      ipOrigen: null,
      correlationId: null,
      detalle: { aprobacionId: aprobacion.id, ejecucionId: aprobacion.ejecucionId, decision: comando.decision },
    });

    const ejecucion =
      comando.decision === 'APROBAR'
        ? await this.motor.reanudarTrasAprobacion(aprobacion)
        : await this.motor.cerrarPorRechazo(aprobacion);
    return ejecucion.snapshot();
  }
}

// ============================== Consultas (bandeja y trazador) ==============================
export interface TrazaEjecucion {
  readonly ejecucion: EjecucionProps;
  readonly pasos: PasoProps[];
  readonly aprobaciones: AprobacionProps[];
}

export class ConsultasCasoUso {
  constructor(
    private readonly ejecuciones: EjecucionRepositorio,
    private readonly pasos: PasoRepositorio,
    private readonly aprobaciones: AprobacionRepositorio,
  ) {}

  async listarAprobacionesPendientes(limite = 50): Promise<AprobacionProps[]> {
    const lista = await this.aprobaciones.listarPendientes(this.acotar(limite));
    return lista.map((a) => a.snapshot());
  }

  async listarEjecuciones(limite = 50): Promise<EjecucionProps[]> {
    const lista = await this.ejecuciones.listar(this.acotar(limite));
    return lista.map((e) => e.snapshot());
  }

  async obtenerTraza(ejecucionId: string): Promise<TrazaEjecucion> {
    const ejecucion = await this.ejecuciones.obtenerPorId(ejecucionId);
    if (!ejecucion) throw new ErrorNoEncontrado('ejecucion', ejecucionId);
    const [pasos, aprobaciones] = await Promise.all([
      this.pasos.listarPorEjecucion(ejecucionId),
      this.aprobaciones.listarPorEjecucion(ejecucionId),
    ]);
    return {
      ejecucion: ejecucion.snapshot(),
      pasos: pasos.map((p) => p.snapshot()),
      aprobaciones: aprobaciones.map((a) => a.snapshot()),
    };
  }

  private acotar(limite: number): number {
    if (!Number.isInteger(limite) || limite < 1) return 50;
    return Math.min(limite, 200);
  }
}
