// Puertos (interfaces) del dominio. Sin dependencias de infraestructura.
import type {
  AprobacionHumana,
  EjecucionAgente,
  EstadoPaso,
  EventoAuditoria,
  FlujoDefinicion,
  JsonObjeto,
  NombreHerramienta,
  PasoEjecucion,
  ProveedorCatalogo,
} from './entities';

// ---------------- Repositorios ----------------
export interface FlujoRepositorio {
  obtenerPorNombre(nombre: string): Promise<FlujoDefinicion | null>;
  obtenerPorId(id: string): Promise<FlujoDefinicion | null>;
}

export interface EjecucionRepositorio {
  /** Upsert por id. */
  guardar(ejecucion: EjecucionAgente): Promise<void>;
  obtenerPorId(id: string): Promise<EjecucionAgente | null>;
  listar(limite: number): Promise<EjecucionAgente[]>;
}

export interface PasoRepositorio {
  /** Upsert por id. */
  guardar(paso: PasoEjecucion): Promise<void>;
  obtenerPorId(id: string): Promise<PasoEjecucion | null>;
  listarPorEjecucion(ejecucionId: string): Promise<PasoEjecucion[]>;
}

export interface AprobacionRepositorio {
  /** Upsert por id. */
  guardar(aprobacion: AprobacionHumana): Promise<void>;
  obtenerPorId(id: string): Promise<AprobacionHumana | null>;
  listarPendientes(limite: number): Promise<AprobacionHumana[]>;
  listarPorEjecucion(ejecucionId: string): Promise<AprobacionHumana[]>;
}

export interface FiltroCatalogo {
  categoria?: string;
  texto?: string;
  sku?: string;
  limite: number;
}

export interface CatalogoProveedoresRepositorio {
  buscar(filtro: FiltroCatalogo): Promise<ProveedorCatalogo[]>;
}

// ---------------- Servicios externos ----------------
export interface AuditoriaPuerto {
  registrar(evento: EventoAuditoria): Promise<void>;
}

export interface NotificadorPuerto {
  enviar(destinatario: string, asunto: string, mensaje: string): Promise<void>;
}

export interface AlmacenPropuestasPuerto {
  /** Persiste el documento y devuelve su ubicación (por ejemplo s3://bucket/clave). */
  guardar(clave: string, contenido: JsonObjeto): Promise<string>;
}

export interface ColaTareasPuerto {
  encolar(ejecucionId: string, correlationId: string): Promise<void>;
}

export interface RelojPuerto {
  ahora(): Date;
}

export interface GeneradorIdPuerto {
  nuevo(): string;
}

// ---------------- Puerto LLM ----------------
export interface ContextoRazonamiento {
  readonly ejecucionId: string;
  readonly flujo: { readonly nombre: string; readonly descripcion: string };
  readonly entrada: JsonObjeto;
  readonly herramientas: ReadonlyArray<{ readonly nombre: NombreHerramienta; readonly descripcion: string }>;
  readonly historial: ReadonlyArray<{
    readonly orden: number;
    readonly herramienta: string;
    readonly entrada: JsonObjeto;
    readonly salida: JsonObjeto | null;
    readonly estado: EstadoPaso;
  }>;
  readonly pasoActual: number;
  readonly maxPasos: number;
}

export type DecisionAgente =
  | {
      readonly tipo: 'HERRAMIENTA';
      /** Cadena libre: puede ser una alucinación del modelo; el motor la valida. */
      readonly herramienta: string;
      readonly entrada: JsonObjeto;
      readonly razonamiento: string;
    }
  | {
      readonly tipo: 'FINAL';
      readonly resultado: JsonObjeto;
      readonly razonamiento: string;
    };

export interface LlmPuerto {
  decidir(contexto: ContextoRazonamiento): Promise<DecisionAgente>;
}
