import { isIP } from 'node:net';
import { Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  AprobacionHumana,
  Dinero,
  EjecucionAgente,
  ErrorTransicionInvalida,
  PasoEjecucion,
  esNombreHerramienta,
  type EstadoAprobacion,
  type EstadoEjecucion,
  type EstadoPaso,
  type EventoAuditoria,
  type FlujoDefinicion,
  type JsonObjeto,
  type OrigenEjecucion,
  type ProveedorCatalogo,
} from '../../domain/entities';
import type {
  AprobacionRepositorio,
  AuditoriaPuerto,
  CatalogoProveedoresRepositorio,
  EjecucionRepositorio,
  FiltroCatalogo,
  FlujoRepositorio,
  PasoRepositorio,
  RegistroAuditoriaLeido,
} from '../../domain/ports';

const textoJson = (valor: JsonObjeto): string => JSON.stringify(valor);
const textoJsonONulo = (valor: JsonObjeto | null): string | null => (valor === null ? null : JSON.stringify(valor));

// ============================== Flujos ==============================
type FilaFlujo = {
  id: string;
  nombre: string;
  descripcion: string;
  version: number;
  herramientas_permitidas: string[];
  umbral_aprobacion_usd: string;
  activo: boolean;
};

const COLUMNAS_FLUJO =
  'id, nombre, descripcion, version, herramientas_permitidas, umbral_aprobacion_usd, activo';

function aFlujo(f: FilaFlujo): FlujoDefinicion {
  return {
    id: f.id,
    nombre: f.nombre,
    descripcion: f.descripcion,
    version: f.version,
    herramientasPermitidas: f.herramientas_permitidas.filter(esNombreHerramienta),
    umbralAprobacion: Dinero.deUsd(Number(f.umbral_aprobacion_usd)),
    activo: f.activo,
  };
}

export class FlujoPostgres implements FlujoRepositorio {
  constructor(private readonly pool: Pool) {}

  async obtenerPorNombre(nombre: string): Promise<FlujoDefinicion | null> {
    const r = await this.pool.query<FilaFlujo>(
      `SELECT ${COLUMNAS_FLUJO} FROM flujos_definicion WHERE nombre = $1`,
      [nombre],
    );
    const fila = r.rows[0];
    return fila === undefined ? null : aFlujo(fila);
  }

  async obtenerPorId(id: string): Promise<FlujoDefinicion | null> {
    const r = await this.pool.query<FilaFlujo>(`SELECT ${COLUMNAS_FLUJO} FROM flujos_definicion WHERE id = $1`, [id]);
    const fila = r.rows[0];
    return fila === undefined ? null : aFlujo(fila);
  }

  async listarActivos(): Promise<FlujoDefinicion[]> {
    const r = await this.pool.query<FilaFlujo>(
      `SELECT ${COLUMNAS_FLUJO} FROM flujos_definicion WHERE activo = TRUE ORDER BY nombre ASC`,
    );
    return r.rows.map(aFlujo);
  }
}

// ============================== Ejecuciones ==============================
type FilaEjecucion = {
  id: string;
  flujo_id: string;
  estado: EstadoEjecucion;
  origen: OrigenEjecucion;
  entrada: JsonObjeto;
  resultado: JsonObjeto | null;
  error: string | null;
  correlation_id: string;
  iniciado_en: Date;
  finalizado_en: Date | null;
};

const COLUMNAS_EJECUCION =
  'id, flujo_id, estado, origen, entrada, resultado, error, correlation_id, iniciado_en, finalizado_en';

function aEjecucion(f: FilaEjecucion): EjecucionAgente {
  return EjecucionAgente.rehidratar({
    id: f.id,
    flujoId: f.flujo_id,
    estado: f.estado,
    origen: f.origen,
    entrada: f.entrada,
    resultado: f.resultado,
    error: f.error,
    correlationId: f.correlation_id,
    iniciadoEn: f.iniciado_en,
    finalizadoEn: f.finalizado_en,
  });
}

export class EjecucionPostgres implements EjecucionRepositorio {
  constructor(private readonly pool: Pool) {}

  async guardar(ejecucion: EjecucionAgente): Promise<void> {
    const d = ejecucion.snapshot();
    await this.pool.query(
      `INSERT INTO ejecuciones_agente
         (id, flujo_id, estado, origen, entrada, resultado, error, correlation_id, iniciado_en, finalizado_en, actualizado_en)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, NOW())
       ON CONFLICT (id) DO UPDATE SET
         estado = EXCLUDED.estado,
         resultado = EXCLUDED.resultado,
         error = EXCLUDED.error,
         finalizado_en = EXCLUDED.finalizado_en,
         actualizado_en = NOW()`,
      [
        d.id,
        d.flujoId,
        d.estado,
        d.origen,
        textoJson(d.entrada),
        textoJsonONulo(d.resultado),
        d.error,
        d.correlationId,
        d.iniciadoEn,
        d.finalizadoEn,
      ],
    );
  }

  async obtenerPorId(id: string): Promise<EjecucionAgente | null> {
    const r = await this.pool.query<FilaEjecucion>(
      `SELECT ${COLUMNAS_EJECUCION} FROM ejecuciones_agente WHERE id = $1`,
      [id],
    );
    const fila = r.rows[0];
    return fila === undefined ? null : aEjecucion(fila);
  }

  async listar(limite: number): Promise<EjecucionAgente[]> {
    const r = await this.pool.query<FilaEjecucion>(
      `SELECT ${COLUMNAS_EJECUCION} FROM ejecuciones_agente ORDER BY iniciado_en DESC LIMIT $1`,
      [limite],
    );
    return r.rows.map(aEjecucion);
  }
}

// ============================== Pasos ==============================
type FilaPaso = {
  id: string;
  ejecucion_id: string;
  orden: number;
  herramienta: string;
  razonamiento: string | null;
  entrada: JsonObjeto;
  salida: JsonObjeto | null;
  estado: EstadoPaso;
  error: string | null;
  duracion_ms: number | null;
  creado_en: Date;
};

const COLUMNAS_PASO =
  'id, ejecucion_id, orden, herramienta, razonamiento, entrada, salida, estado, error, duracion_ms, creado_en';

function aPaso(f: FilaPaso): PasoEjecucion {
  return PasoEjecucion.rehidratar({
    id: f.id,
    ejecucionId: f.ejecucion_id,
    orden: f.orden,
    herramienta: f.herramienta,
    razonamiento: f.razonamiento,
    entrada: f.entrada,
    salida: f.salida,
    estado: f.estado,
    error: f.error,
    duracionMs: f.duracion_ms,
    creadoEn: f.creado_en,
  });
}

export class PasoPostgres implements PasoRepositorio {
  constructor(private readonly pool: Pool) {}

  async guardar(paso: PasoEjecucion): Promise<void> {
    const d = paso.snapshot();
    await this.pool.query(
      `INSERT INTO pasos_ejecucion
         (id, ejecucion_id, orden, herramienta, razonamiento, entrada, salida, estado, error, duracion_ms, creado_en)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET
         salida = EXCLUDED.salida,
         estado = EXCLUDED.estado,
         error = EXCLUDED.error,
         duracion_ms = EXCLUDED.duracion_ms`,
      [
        d.id,
        d.ejecucionId,
        d.orden,
        d.herramienta,
        d.razonamiento,
        textoJson(d.entrada),
        textoJsonONulo(d.salida),
        d.estado,
        d.error,
        d.duracionMs,
        d.creadoEn,
      ],
    );
  }

  async obtenerPorId(id: string): Promise<PasoEjecucion | null> {
    const r = await this.pool.query<FilaPaso>(`SELECT ${COLUMNAS_PASO} FROM pasos_ejecucion WHERE id = $1`, [id]);
    const fila = r.rows[0];
    return fila === undefined ? null : aPaso(fila);
  }

  async listarPorEjecucion(ejecucionId: string): Promise<PasoEjecucion[]> {
    const r = await this.pool.query<FilaPaso>(
      `SELECT ${COLUMNAS_PASO} FROM pasos_ejecucion WHERE ejecucion_id = $1 ORDER BY orden ASC`,
      [ejecucionId],
    );
    return r.rows.map(aPaso);
  }
}

// ============================== Aprobaciones ==============================
type FilaAprobacion = {
  id: string;
  ejecucion_id: string;
  paso_id: string | null;
  accion_propuesta: JsonObjeto;
  motivo: string;
  monto_usd: string | null;
  estado: EstadoAprobacion;
  solicitado_en: Date;
  resuelto_en: Date | null;
  resuelto_por: string | null;
  comentario: string | null;
};

const COLUMNAS_APROBACION =
  'id, ejecucion_id, paso_id, accion_propuesta, motivo, monto_usd, estado, solicitado_en, resuelto_en, resuelto_por, comentario';

function aAprobacion(f: FilaAprobacion): AprobacionHumana {
  return AprobacionHumana.rehidratar({
    id: f.id,
    ejecucionId: f.ejecucion_id,
    pasoId: f.paso_id,
    accionPropuesta: f.accion_propuesta,
    motivo: f.motivo,
    montoUsd: f.monto_usd === null ? null : Number(f.monto_usd),
    estado: f.estado,
    solicitadoEn: f.solicitado_en,
    resueltoEn: f.resuelto_en,
    resueltoPor: f.resuelto_por,
    comentario: f.comentario,
  });
}

export class AprobacionPostgres implements AprobacionRepositorio {
  constructor(private readonly pool: Pool) {}

  async guardar(aprobacion: AprobacionHumana): Promise<void> {
    const d = aprobacion.snapshot();
    if (d.estado === 'PENDIENTE') {
      await this.pool.query(
        `INSERT INTO aprobaciones_humanas
           (id, ejecucion_id, paso_id, accion_propuesta, motivo, monto_usd, estado, solicitado_en, resuelto_en, resuelto_por, comentario)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO NOTHING`,
        [
          d.id,
          d.ejecucionId,
          d.pasoId,
          textoJson(d.accionPropuesta),
          d.motivo,
          d.montoUsd,
          d.estado,
          d.solicitadoEn,
          d.resueltoEn,
          d.resueltoPor,
          d.comentario,
        ],
      );
      return;
    }

    // Actualización condicional atómica: solo una réplica puede transicionar desde PENDIENTE.
    const resultado = await this.pool.query(
      `UPDATE aprobaciones_humanas
          SET estado = $2,
              resuelto_en = $3,
              resuelto_por = $4,
              comentario = $5
        WHERE id = $1
          AND estado = 'PENDIENTE'`,
      [d.id, d.estado, d.resueltoEn, d.resueltoPor, d.comentario],
    );
    if ((resultado.rowCount ?? 0) === 0) {
      throw new ErrorTransicionInvalida('aprobacion', 'RESUELTA', d.estado);
    }
  }

  async obtenerPorId(id: string): Promise<AprobacionHumana | null> {
    const r = await this.pool.query<FilaAprobacion>(
      `SELECT ${COLUMNAS_APROBACION} FROM aprobaciones_humanas WHERE id = $1`,
      [id],
    );
    const fila = r.rows[0];
    return fila === undefined ? null : aAprobacion(fila);
  }

  async listarPendientes(limite: number): Promise<AprobacionHumana[]> {
    const r = await this.pool.query<FilaAprobacion>(
      `SELECT ${COLUMNAS_APROBACION} FROM aprobaciones_humanas
        WHERE estado = 'PENDIENTE' ORDER BY solicitado_en ASC LIMIT $1`,
      [limite],
    );
    return r.rows.map(aAprobacion);
  }

  async listarPorEjecucion(ejecucionId: string): Promise<AprobacionHumana[]> {
    const r = await this.pool.query<FilaAprobacion>(
      `SELECT ${COLUMNAS_APROBACION} FROM aprobaciones_humanas
        WHERE ejecucion_id = $1 ORDER BY solicitado_en ASC`,
      [ejecucionId],
    );
    return r.rows.map(aAprobacion);
  }
}

// ============================== Catálogo ==============================
type FilaProveedor = {
  id: string;
  nombre: string;
  categoria: string;
  sku: string;
  descripcion: string;
  precio_unitario_usd: string;
  plazo_entrega_dias: number;
  calificacion: string;
  pais: string;
  activo: boolean;
};

function escaparLike(texto: string): string {
  return texto.replace(/[\\%_]/g, '\\$&');
}

export class CatalogoPostgres implements CatalogoProveedoresRepositorio {
  constructor(private readonly pool: Pool) {}

  async buscar(filtro: FiltroCatalogo): Promise<ProveedorCatalogo[]> {
    const condiciones: string[] = ['activo = TRUE'];
    const parametros: unknown[] = [];

    if (filtro.categoria !== undefined) {
      parametros.push(filtro.categoria);
      condiciones.push(`lower(categoria) = lower($${parametros.length})`);
    }
    if (filtro.sku !== undefined) {
      parametros.push(filtro.sku);
      condiciones.push(`sku = $${parametros.length}`);
    }
    if (filtro.texto !== undefined) {
      parametros.push(`%${escaparLike(filtro.texto)}%`);
      const n = parametros.length;
      condiciones.push(`(descripcion ILIKE $${n} OR nombre ILIKE $${n} OR sku ILIKE $${n})`);
    }
    parametros.push(Math.max(1, Math.min(filtro.limite, 100)));

    const r = await this.pool.query<FilaProveedor>(
      `SELECT id, nombre, categoria, sku, descripcion, precio_unitario_usd, plazo_entrega_dias, calificacion, pais, activo
         FROM catalogo_proveedores
        WHERE ${condiciones.join(' AND ')}
        ORDER BY categoria ASC, precio_unitario_usd ASC, sku ASC
        LIMIT $${parametros.length}`,
      parametros,
    );
    return r.rows.map(
      (f): ProveedorCatalogo => ({
        id: f.id,
        nombre: f.nombre,
        categoria: f.categoria,
        sku: f.sku,
        descripcion: f.descripcion,
        precioUnitarioUsd: Number(f.precio_unitario_usd),
        plazoEntregaDias: f.plazo_entrega_dias,
        calificacion: Number(f.calificacion),
        pais: f.pais,
        activo: f.activo,
      }),
    );
  }
}

// ============================== Auditoría (append-only) ==============================
export class AuditoriaPostgres implements AuditoriaPuerto {
  private readonly log = new Logger('Auditoria');

  constructor(private readonly pool: Pool) {}

  async registrar(evento: EventoAuditoria): Promise<void> {
    const ip = evento.ipOrigen !== null && isIP(evento.ipOrigen) !== 0 ? evento.ipOrigen : null;
    try {
      await this.pool.query(
        `INSERT INTO auditoria_seguridad (tipo_evento, severidad, actor, ip_origen, correlation_id, detalle)
         VALUES ($1, $2, $3, $4::inet, $5, $6::jsonb)`,
        [
          evento.tipoEvento.slice(0, 64),
          evento.severidad,
          evento.actor === null ? null : evento.actor.slice(0, 120),
          ip,
          evento.correlationId === null ? null : evento.correlationId.slice(0, 64),
          textoJson(evento.detalle),
        ],
      );
    } catch (error) {
      this.log.error(
        `No se pudo registrar el evento de auditoría ${evento.tipoEvento}: ${error instanceof Error ? error.message : 'error desconocido'}`,
      );
    }
  }

  async listarRecientes(filtro: {
    limite: number;
    tipoEvento?: string;
    severidad?: string;
  }): Promise<RegistroAuditoriaLeido[]> {
    const condiciones: string[] = [];
    const params: unknown[] = [];
    if (filtro.tipoEvento !== undefined) {
      params.push(filtro.tipoEvento);
      condiciones.push(`tipo_evento = $${params.length}`);
    }
    if (filtro.severidad !== undefined) {
      params.push(filtro.severidad);
      condiciones.push(`severidad = $${params.length}`);
    }
    params.push(Math.max(1, Math.min(filtro.limite, 100)));
    const where = condiciones.length > 0 ? `WHERE ${condiciones.join(' AND ')}` : '';
    const r = await this.pool.query<{
      id: string;
      tipo_evento: string;
      severidad: 'INFO' | 'WARN' | 'ALTA' | 'CRITICA';
      actor: string | null;
      ip_origen: string | null;
      correlation_id: string | null;
      detalle: JsonObjeto;
      creado_en: Date;
    }>(
      `SELECT id, tipo_evento, severidad, actor, ip_origen::text, correlation_id, detalle, creado_en
         FROM auditoria_seguridad
         ${where}
        ORDER BY creado_en DESC
        LIMIT $${params.length}`,
      params,
    );
    return r.rows.map((f) => ({
      id: Number(f.id),
      tipoEvento: f.tipo_evento,
      severidad: f.severidad,
      actor: f.actor,
      ipOrigen: f.ip_origen,
      correlationId: f.correlation_id,
      detalle: f.detalle,
      creadoEn: f.creado_en,
    }));
  }
}
