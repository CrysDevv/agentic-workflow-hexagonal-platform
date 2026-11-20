import {
  AprobacionHumana,
  EjecucionAgente,
  ErrorNoEncontrado,
  ErrorTransicionInvalida,
  ErrorValidacion,
  PasoEjecucion,
  esNombreHerramienta,
  type Dinero,
  type FlujoDefinicion,
  type JsonObjeto,
  type SeveridadAuditoria,
} from '../../domain/entities';
import type {
  AprobacionRepositorio,
  AuditoriaPuerto,
  ContextoRazonamiento,
  DecisionAgente,
  EjecucionRepositorio,
  FlujoRepositorio,
  GeneradorIdPuerto,
  LlmPuerto,
  PasoRepositorio,
  RelojPuerto,
} from '../../domain/ports';
import type { GuardrailPromptInjection, ResultadoGuardrail } from '../guardrails/prompt-injection.guardrail';
import type { ContextoHerramienta, RegistroHerramientas } from '../tools/tool-registry';

export const MAX_PASOS_POR_EJECUCION = 8;

export interface DependenciasMotor {
  readonly ejecuciones: EjecucionRepositorio;
  readonly pasos: PasoRepositorio;
  readonly aprobaciones: AprobacionRepositorio;
  readonly flujos: FlujoRepositorio;
  readonly llm: LlmPuerto;
  readonly herramientas: RegistroHerramientas;
  readonly guardrail: GuardrailPromptInjection;
  readonly auditoria: AuditoriaPuerto;
  readonly reloj: RelojPuerto;
  readonly ids: GeneradorIdPuerto;
}

type DecisionHerramienta = Extract<DecisionAgente, { tipo: 'HERRAMIENTA' }>;

export class MotorAgente {
  constructor(
    private readonly d: DependenciasMotor,
    private readonly maxPasos: number = MAX_PASOS_POR_EJECUCION,
  ) {}

  /** Ejecuta una ejecución PENDIENTE. Idempotente ante reentregas de la cola. */
  async ejecutar(ejecucionId: string): Promise<EjecucionAgente> {
    const ejecucion = await this.cargarEjecucion(ejecucionId);
    if (ejecucion.estado !== 'PENDIENTE') return ejecucion;

    const flujo = await this.cargarFlujo(ejecucion.flujoId);
    ejecucion.iniciar(this.d.reloj.ahora());
    await this.d.ejecuciones.guardar(ejecucion);

    const analisis = this.d.guardrail.analizar(ejecucion.entrada);
    if (analisis.bloqueado) {
      return this.rechazarPorGuardrail(ejecucion, 'ENTRADA_EJECUCION', analisis);
    }
    return this.bucle(ejecucion, flujo);
  }

  /** Reanuda una ejecución pausada tras una aprobación humana positiva. */
  async reanudarTrasAprobacion(aprobacion: AprobacionHumana): Promise<EjecucionAgente> {
    if (aprobacion.estado !== 'APROBADA') {
      throw new ErrorTransicionInvalida('aprobacion', aprobacion.estado, 'REANUDAR');
    }
    const ejecucion = await this.cargarEjecucion(aprobacion.ejecucionId);
    if (ejecucion.estado !== 'PAUSADA_APROBACION') {
      throw new ErrorTransicionInvalida('ejecucion', ejecucion.estado, 'EN_EJECUCION');
    }
    if (!aprobacion.pasoId) {
      throw new ErrorValidacion('La aprobación no está vinculada a un paso');
    }
    const paso = await this.d.pasos.obtenerPorId(aprobacion.pasoId);
    if (!paso || paso.estado !== 'PENDIENTE') {
      throw new ErrorNoEncontrado('paso pendiente', aprobacion.pasoId);
    }
    const flujo = await this.cargarFlujo(ejecucion.flujoId);

    ejecucion.reanudar(this.d.reloj.ahora());
    await this.d.ejecuciones.guardar(ejecucion);

    try {
      const continuar = await this.procesarPaso(ejecucion, flujo, paso, true);
      if (!continuar) return ejecucion;
      return await this.bucle(ejecucion, flujo);
    } catch (error) {
      return this.cerrarConFallo(ejecucion, error);
    }
  }

  /** Cierra la ejecución cuando el humano rechaza la acción propuesta. */
  async cerrarPorRechazo(aprobacion: AprobacionHumana): Promise<EjecucionAgente> {
    if (aprobacion.estado !== 'RECHAZADA') {
      throw new ErrorTransicionInvalida('aprobacion', aprobacion.estado, 'CERRAR_POR_RECHAZO');
    }
    const ejecucion = await this.cargarEjecucion(aprobacion.ejecucionId);
    const aprobador = aprobacion.resueltoPor ?? 'desconocido';

    if (aprobacion.pasoId) {
      const paso = await this.d.pasos.obtenerPorId(aprobacion.pasoId);
      if (paso && paso.estado === 'PENDIENTE') {
        paso.bloquear(`Acción rechazada por ${aprobador}`);
        await this.d.pasos.guardar(paso);
      }
    }
    ejecucion.rechazar(`Acción rechazada por el aprobador ${aprobador}`, this.d.reloj.ahora());
    await this.d.ejecuciones.guardar(ejecucion);
    await this.auditar('EJECUCION_RECHAZADA_POR_HUMANO', 'INFO', ejecucion, { aprobador });
    return ejecucion;
  }

  // ============================== Bucle de razonamiento ==============================
  private async bucle(ejecucion: EjecucionAgente, flujo: FlujoDefinicion): Promise<EjecucionAgente> {
    try {
      for (;;) {
        const historial = await this.d.pasos.listarPorEjecucion(ejecucion.id);
        if (historial.length >= this.maxPasos) {
          return await this.cerrarConFallo(
            ejecucion,
            new Error(`Se excedió el límite de ${this.maxPasos} pasos por ejecución`),
          );
        }

        const decision = await this.d.llm.decidir(this.construirContexto(ejecucion, flujo, historial));

        // Defensa en profundidad: la decisión del modelo también es contenido no confiable.
        const analisis = this.d.guardrail.analizar(decision.tipo === 'FINAL' ? decision.resultado : decision.entrada);
        if (analisis.bloqueado) {
          return await this.rechazarPorGuardrail(ejecucion, 'DECISION_LLM', analisis);
        }

        if (decision.tipo === 'FINAL') {
          ejecucion.completar(decision.resultado, this.d.reloj.ahora());
          await this.d.ejecuciones.guardar(ejecucion);
          await this.auditar('EJECUCION_COMPLETADA', 'INFO', ejecucion, { pasos: historial.length });
          return ejecucion;
        }

        const paso = this.crearPaso(ejecucion, decision, historial.length + 1);
        const continuar = await this.procesarPaso(ejecucion, flujo, paso, false);
        if (!continuar) return ejecucion;
      }
    } catch (error) {
      return this.cerrarConFallo(ejecucion, error);
    }
  }

  private crearPaso(ejecucion: EjecucionAgente, decision: DecisionHerramienta, orden: number): PasoEjecucion {
    return PasoEjecucion.crear({
      id: this.d.ids.nuevo(),
      ejecucionId: ejecucion.id,
      orden,
      herramienta: decision.herramienta,
      razonamiento: decision.razonamiento.slice(0, 2000),
      entrada: decision.entrada,
      ahora: this.d.reloj.ahora(),
    });
  }

  /**
   * Procesa un paso. Devuelve true si el bucle debe continuar; false si la ejecución quedó
   * pausada o en estado terminal.
   */
  private async procesarPaso(
    ejecucion: EjecucionAgente,
    flujo: FlujoDefinicion,
    paso: PasoEjecucion,
    aprobado: boolean,
  ): Promise<boolean> {
    const nombre = paso.herramienta;
    const herramienta =
      esNombreHerramienta(nombre) && flujo.herramientasPermitidas.includes(nombre)
        ? this.d.herramientas.obtener(nombre)
        : undefined;

    if (!herramienta) {
      paso.bloquear('Herramienta no permitida para este flujo o inexistente');
      await this.d.pasos.guardar(paso);
      await this.auditar('HERRAMIENTA_NO_PERMITIDA', 'ALTA', ejecucion, { herramienta: nombre });
      ejecucion.rechazar(`Herramienta no permitida: ${nombre}`, this.d.reloj.ahora());
      await this.d.ejecuciones.guardar(ejecucion);
      return false;
    }

    const ctx: ContextoHerramienta = {
      ejecucionId: ejecucion.id,
      correlationId: ejecucion.correlationId,
      flujo,
    };
    const inicio = this.d.reloj.ahora().getTime();

    try {
      const preparacion = await herramienta.preparar(paso.entrada, ctx);

      // El umbral lo impone el motor: el modelo no puede omitir la validación presupuestaria.
      if (
        herramienta.critica &&
        !aprobado &&
        preparacion.monto !== null &&
        preparacion.monto.superaA(flujo.umbralAprobacion)
      ) {
        await this.solicitarAprobacion(ejecucion, flujo, paso, preparacion.entrada, preparacion.monto);
        return false;
      }

      paso.iniciar();
      await this.d.pasos.guardar(paso);

      const salida = await preparacion.ejecutar();
      const duracion = this.d.reloj.ahora().getTime() - inicio;

      // Defensa contra inyección indirecta: la salida de una herramienta es contenido no confiable.
      const analisis = this.d.guardrail.analizar(salida);
      if (analisis.bloqueado) {
        paso.bloquear('Salida de herramienta bloqueada por el guardrail anti-prompt-injection');
        await this.d.pasos.guardar(paso);
        await this.rechazarPorGuardrail(ejecucion, `SALIDA_HERRAMIENTA:${nombre}`, analisis);
        return false;
      }

      paso.completar(salida, duracion);
      await this.d.pasos.guardar(paso);
      return true;
    } catch (error) {
      if (paso.estado === 'PENDIENTE' || paso.estado === 'EN_EJECUCION') {
        const duracion = this.d.reloj.ahora().getTime() - inicio;
        paso.fallar(this.mensaje(error), duracion);
        await this.d.pasos.guardar(paso);
      }
      throw error;
    }
  }

  private async solicitarAprobacion(
    ejecucion: EjecucionAgente,
    flujo: FlujoDefinicion,
    paso: PasoEjecucion,
    entradaNormalizada: JsonObjeto,
    monto: Dinero,
  ): Promise<void> {
    await this.d.pasos.guardar(paso); // el paso queda PENDIENTE y es referenciado por la aprobación

    const aprobacion = AprobacionHumana.crear({
      id: this.d.ids.nuevo(),
      ejecucionId: ejecucion.id,
      pasoId: paso.id,
      accionPropuesta: {
        herramienta: paso.herramienta,
        entrada: entradaNormalizada,
        montoUsd: monto.usd,
      },
      motivo: `El monto de ${monto.usd.toFixed(2)} USD supera el umbral de aprobación de ${flujo.umbralAprobacion.usd.toFixed(2)} USD`,
      montoUsd: monto.usd,
      ahora: this.d.reloj.ahora(),
    });
    await this.d.aprobaciones.guardar(aprobacion);

    ejecucion.pausarPorAprobacion(this.d.reloj.ahora());
    await this.d.ejecuciones.guardar(ejecucion);
    await this.auditar('APROBACION_SOLICITADA', 'INFO', ejecucion, {
      aprobacionId: aprobacion.id,
      herramienta: paso.herramienta,
      montoUsd: monto.usd,
    });
  }

  // ============================== Utilidades ==============================
  private construirContexto(
    ejecucion: EjecucionAgente,
    flujo: FlujoDefinicion,
    historial: readonly PasoEjecucion[],
  ): ContextoRazonamiento {
    return {
      ejecucionId: ejecucion.id,
      flujo: { nombre: flujo.nombre, descripcion: flujo.descripcion },
      entrada: ejecucion.entrada,
      herramientas: this.d.herramientas
        .disponiblesPara(flujo.herramientasPermitidas)
        .map((h) => ({ nombre: h.nombre, descripcion: h.descripcion })),
      historial: historial.map((p) => ({
        orden: p.orden,
        herramienta: p.herramienta,
        entrada: p.entrada,
        salida: p.salida,
        estado: p.estado,
      })),
      pasoActual: historial.length + 1,
      maxPasos: this.maxPasos,
    };
  }

  private async rechazarPorGuardrail(
    ejecucion: EjecucionAgente,
    origen: string,
    analisis: ResultadoGuardrail,
  ): Promise<EjecucionAgente> {
    await this.auditar('PROMPT_INJECTION_BLOQUEADA', analisis.severidad, ejecucion, {
      origen,
      puntaje: analisis.puntaje,
      reglas: [...analisis.reglas],
    });
    ejecucion.rechazar('Contenido bloqueado por el guardrail anti-prompt-injection', this.d.reloj.ahora());
    await this.d.ejecuciones.guardar(ejecucion);
    return ejecucion;
  }

  private async cerrarConFallo(ejecucion: EjecucionAgente, error: unknown): Promise<EjecucionAgente> {
    if (ejecucion.estado !== 'EN_EJECUCION') {
      throw error;
    }
    ejecucion.fallar(this.mensaje(error), this.d.reloj.ahora());
    await this.d.ejecuciones.guardar(ejecucion);
    await this.auditar('EJECUCION_FALLIDA', 'WARN', ejecucion, { error: this.mensaje(error).slice(0, 300) });
    return ejecucion;
  }

  private mensaje(error: unknown): string {
    return error instanceof Error ? error.message : 'Error desconocido';
  }

  private async cargarEjecucion(id: string): Promise<EjecucionAgente> {
    const ejecucion = await this.d.ejecuciones.obtenerPorId(id);
    if (!ejecucion) throw new ErrorNoEncontrado('ejecucion', id);
    return ejecucion;
  }

  private async cargarFlujo(id: string): Promise<FlujoDefinicion> {
    const flujo = await this.d.flujos.obtenerPorId(id);
    if (!flujo) throw new ErrorNoEncontrado('flujo', id);
    return flujo;
  }

  private auditar(
    tipo: string,
    severidad: SeveridadAuditoria,
    ejecucion: EjecucionAgente,
    detalle: JsonObjeto,
  ): Promise<void> {
    return this.d.auditoria.registrar({
      tipoEvento: tipo,
      severidad,
      actor: 'agente',
      ipOrigen: null,
      correlationId: ejecucion.correlationId,
      detalle: { ejecucionId: ejecucion.id, ...detalle },
    });
  }
}
