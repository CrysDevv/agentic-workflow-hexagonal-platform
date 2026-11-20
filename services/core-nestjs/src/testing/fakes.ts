// Dobles de prueba en memoria que implementan los puertos del dominio. Excluido del build de producción.
import { MotorAgente } from '../application/agent/agent-engine';
import { GuardrailPromptInjection } from '../application/guardrails/prompt-injection.guardrail';
import { crearRegistroHerramientas } from '../application/tools/herramientas-comerciales';
import type { RegistroHerramientas } from '../application/tools/tool-registry';
import {
  ConsultasCasoUso,
  IniciarEjecucionCasoUso,
  ProcesarEjecucionCasoUso,
  ResolverAprobacionCasoUso,
} from '../application/use-cases';
import {
  AprobacionHumana,
  Dinero,
  EjecucionAgente,
  NOMBRES_HERRAMIENTA,
  PasoEjecucion,
  type EventoAuditoria,
  type FlujoDefinicion,
  type JsonObjeto,
  type ProveedorCatalogo,
} from '../domain/entities';
import type {
  AlmacenPropuestasPuerto,
  AprobacionRepositorio,
  AuditoriaPuerto,
  CatalogoProveedoresRepositorio,
  ColaTareasPuerto,
  ContextoRazonamiento,
  DecisionAgente,
  EjecucionRepositorio,
  FiltroCatalogo,
  FlujoRepositorio,
  GeneradorIdPuerto,
  LlmPuerto,
  NotificadorPuerto,
  PasoRepositorio,
  RelojPuerto,
} from '../domain/ports';

// ============================== Reloj e identificadores ==============================
export class RelojFijo implements RelojPuerto {
  private actual = new Date('2026-01-15T12:00:00.000Z');

  ahora(): Date {
    return new Date(this.actual.getTime());
  }

  avanzar(ms: number): void {
    this.actual = new Date(this.actual.getTime() + ms);
  }
}

export class GeneradorIdSecuencial implements GeneradorIdPuerto {
  private contador = 0;

  nuevo(): string {
    this.contador += 1;
    return `00000000-0000-4000-8000-${String(this.contador).padStart(12, '0')}`;
  }
}

// ============================== Datos de prueba ==============================
export const FLUJO_PRUEBA: FlujoDefinicion = {
  id: '11111111-1111-4111-8111-111111111111',
  nombre: 'cotizacion-comercial',
  descripcion: 'Flujo de pruebas con todas las herramientas',
  version: 1,
  herramientasPermitidas: [...NOMBRES_HERRAMIENTA],
  umbralAprobacion: Dinero.deUsd(5000),
  activo: true,
};

export const FLUJO_RESTRINGIDO: FlujoDefinicion = {
  id: '22222222-2222-4222-8222-222222222222',
  nombre: 'compra-administrativa',
  descripcion: 'Flujo de pruebas con herramientas limitadas',
  version: 1,
  herramientasPermitidas: ['consultar_catalogo', 'validar_umbral_presupuestario', 'notificar'],
  umbralAprobacion: Dinero.deUsd(2500),
  activo: true,
};

export function crearProveedor(
  sku: string,
  precioUnitarioUsd: number,
  descripcion = 'Artículo de prueba',
  categoria = 'hardware',
): ProveedorCatalogo {
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${sku.replace(/[^0-9a-f]/gi, '0').padEnd(12, '0').slice(0, 12).toLowerCase()}`,
    nombre: 'Proveedor de Pruebas SpA',
    categoria,
    sku,
    descripcion,
    precioUnitarioUsd,
    plazoEntregaDias: 5,
    calificacion: 4.5,
    pais: 'CL',
    activo: true,
  };
}

export const CATALOGO_SEMILLA: readonly ProveedorCatalogo[] = [
  crearProveedor('HW-LAP-001', 1150, 'Laptop empresarial 14 pulgadas', 'hardware'),
  crearProveedor('SW-LIC-010', 96, 'Licencia anual de suite colaborativa', 'software'),
  crearProveedor('SV-AUD-041', 6500, 'Auditoría de seguridad aplicativa', 'servicios'),
];

// ============================== Repositorios en memoria ==============================
export class FlujoMemoria implements FlujoRepositorio {
  private readonly flujos: FlujoDefinicion[];

  constructor(flujos: readonly FlujoDefinicion[]) {
    this.flujos = [...flujos];
  }

  agregar(flujo: FlujoDefinicion): void {
    this.flujos.push(flujo);
  }

  async obtenerPorNombre(nombre: string): Promise<FlujoDefinicion | null> {
    return this.flujos.find((f) => f.nombre === nombre) ?? null;
  }

  async obtenerPorId(id: string): Promise<FlujoDefinicion | null> {
    return this.flujos.find((f) => f.id === id) ?? null;
  }

  async listarActivos(): Promise<FlujoDefinicion[]> {
    return this.flujos.filter((f) => f.activo);
  }
}

export class EjecucionMemoria implements EjecucionRepositorio {
  private readonly datos = new Map<string, ReturnType<EjecucionAgente['snapshot']>>();

  async guardar(ejecucion: EjecucionAgente): Promise<void> {
    this.datos.set(ejecucion.id, ejecucion.snapshot());
  }

  async obtenerPorId(id: string): Promise<EjecucionAgente | null> {
    const d = this.datos.get(id);
    return d === undefined ? null : EjecucionAgente.rehidratar({ ...d });
  }

  async listar(limite: number): Promise<EjecucionAgente[]> {
    return [...this.datos.values()].slice(0, limite).map((d) => EjecucionAgente.rehidratar({ ...d }));
  }
}

export class PasoMemoria implements PasoRepositorio {
  private readonly datos = new Map<string, ReturnType<PasoEjecucion['snapshot']>>();

  async guardar(paso: PasoEjecucion): Promise<void> {
    this.datos.set(paso.id, paso.snapshot());
  }

  async obtenerPorId(id: string): Promise<PasoEjecucion | null> {
    const d = this.datos.get(id);
    return d === undefined ? null : PasoEjecucion.rehidratar({ ...d });
  }

  async listarPorEjecucion(ejecucionId: string): Promise<PasoEjecucion[]> {
    return [...this.datos.values()]
      .filter((d) => d.ejecucionId === ejecucionId)
      .sort((a, b) => a.orden - b.orden)
      .map((d) => PasoEjecucion.rehidratar({ ...d }));
  }
}

export class AprobacionMemoria implements AprobacionRepositorio {
  private readonly datos = new Map<string, ReturnType<AprobacionHumana['snapshot']>>();

  async guardar(aprobacion: AprobacionHumana): Promise<void> {
    this.datos.set(aprobacion.id, aprobacion.snapshot());
  }

  async obtenerPorId(id: string): Promise<AprobacionHumana | null> {
    const d = this.datos.get(id);
    return d === undefined ? null : AprobacionHumana.rehidratar({ ...d });
  }

  async listarPendientes(limite: number): Promise<AprobacionHumana[]> {
    return [...this.datos.values()]
      .filter((d) => d.estado === 'PENDIENTE')
      .slice(0, limite)
      .map((d) => AprobacionHumana.rehidratar({ ...d }));
  }

  async listarPorEjecucion(ejecucionId: string): Promise<AprobacionHumana[]> {
    return [...this.datos.values()]
      .filter((d) => d.ejecucionId === ejecucionId)
      .map((d) => AprobacionHumana.rehidratar({ ...d }));
  }

  async todas(): Promise<AprobacionHumana[]> {
    return [...this.datos.values()].map((d) => AprobacionHumana.rehidratar({ ...d }));
  }
}

export class CatalogoMemoria implements CatalogoProveedoresRepositorio {
  private readonly items: ProveedorCatalogo[];

  constructor(items: readonly ProveedorCatalogo[]) {
    this.items = [...items];
  }

  agregar(item: ProveedorCatalogo): void {
    this.items.push(item);
  }

  async buscar(f: FiltroCatalogo): Promise<ProveedorCatalogo[]> {
    const texto = f.texto?.toLowerCase();
    return this.items
      .filter(
        (p) =>
          p.activo &&
          (f.categoria === undefined || p.categoria.toLowerCase() === f.categoria.toLowerCase()) &&
          (f.sku === undefined || p.sku === f.sku) &&
          (texto === undefined || [p.descripcion, p.nombre, p.sku].some((c) => c.toLowerCase().includes(texto))),
      )
      .slice(0, f.limite);
  }
}

export class AuditoriaMemoria implements AuditoriaPuerto {
  readonly eventos: EventoAuditoria[] = [];

  async registrar(evento: EventoAuditoria): Promise<void> {
    this.eventos.push(evento);
  }

  tipos(): string[] {
    return this.eventos.map((e) => e.tipoEvento);
  }

  async listarRecientes(filtro: { limite: number; tipoEvento?: string; severidad?: string }) {
    return [...this.eventos]
      .reverse()
      .filter(
        (e) =>
          (filtro.tipoEvento === undefined || e.tipoEvento === filtro.tipoEvento) &&
          (filtro.severidad === undefined || e.severidad === filtro.severidad),
      )
      .slice(0, filtro.limite)
      .map((e, idx) => ({ ...e, id: idx + 1, creadoEn: new Date('2026-01-15T12:00:00.000Z') }));
  }
}

export class NotificadorMemoria implements NotificadorPuerto {
  readonly enviados: Array<{ destinatario: string; asunto: string; mensaje: string }> = [];

  async enviar(destinatario: string, asunto: string, mensaje: string): Promise<void> {
    this.enviados.push({ destinatario, asunto, mensaje });
  }
}

export class AlmacenMemoria implements AlmacenPropuestasPuerto {
  readonly documentos = new Map<string, JsonObjeto>();

  async guardar(clave: string, contenido: JsonObjeto): Promise<string> {
    this.documentos.set(clave, contenido);
    return `mem://${clave}`;
  }

  async listar(prefijo: string, limite: number): Promise<string[]> {
    return [...this.documentos.keys()].filter((k) => k.startsWith(prefijo)).reverse().slice(0, limite);
  }

  async leer(clave: string): Promise<JsonObjeto | null> {
    return this.documentos.get(clave) ?? null;
  }
}

export class ColaMemoria implements ColaTareasPuerto {
  readonly tareas: Array<{ ejecucionId: string; correlationId: string }> = [];

  async encolar(ejecucionId: string, correlationId: string): Promise<void> {
    this.tareas.push({ ejecucionId, correlationId });
  }
}

// ============================== LLM guionado ==============================
export class LlmGuionado implements LlmPuerto {
  llamadas = 0;
  readonly contextos: ContextoRazonamiento[] = [];

  constructor(private readonly guion: readonly DecisionAgente[] | ((ctx: ContextoRazonamiento) => DecisionAgente)) {}

  async decidir(ctx: ContextoRazonamiento): Promise<DecisionAgente> {
    this.llamadas += 1;
    this.contextos.push(ctx);
    if (typeof this.guion === 'function') return this.guion(ctx);
    const decision = this.guion[this.llamadas - 1];
    if (decision === undefined) throw new Error('Guion del LLM agotado');
    return decision;
  }
}

// ============================== Redis y Pool falsos ==============================
interface CadenaRedis {
  incr(clave: string): CadenaRedis;
  expire(clave: string, segundos: number): CadenaRedis;
  exec(): Promise<Array<[Error | null, unknown]>>;
}

export class RedisFalso {
  private readonly contadores = new Map<string, number>();
  private readonly claves = new Set<string>();

  async ping(): Promise<string> {
    return 'PONG';
  }

  multi(): CadenaRedis {
    const operaciones: string[] = [];
    const contadores = this.contadores;
    const cadena: CadenaRedis = {
      incr(clave: string): CadenaRedis {
        operaciones.push(clave);
        return cadena;
      },
      expire(): CadenaRedis {
        return cadena;
      },
      async exec(): Promise<Array<[Error | null, unknown]>> {
        const clave = operaciones[0] as string;
        const valor = (contadores.get(clave) ?? 0) + 1;
        contadores.set(clave, valor);
        return [
          [null, valor],
          [null, 1],
        ];
      },
    };
    return cadena;
  }

  async set(clave: string, _valor: string, _ex: string, _segundos: number, modo: string): Promise<'OK' | null> {
    if (modo === 'NX' && this.claves.has(clave)) return null;
    this.claves.add(clave);
    return 'OK';
  }
}

export class PoolFalso {
  fallar = false;

  async query(_sql: string): Promise<{ rows: unknown[] }> {
    if (this.fallar) throw new Error('conexion rechazada');
    return { rows: [{ '?column?': 1 }] };
  }
}

// ============================== Entorno completo ==============================
export interface Entorno {
  readonly reloj: RelojFijo;
  readonly ids: GeneradorIdSecuencial;
  readonly flujos: FlujoMemoria;
  readonly ejecuciones: EjecucionMemoria;
  readonly pasos: PasoMemoria;
  readonly aprobaciones: AprobacionMemoria;
  readonly catalogo: CatalogoMemoria;
  readonly auditoria: AuditoriaMemoria;
  readonly notificador: NotificadorMemoria;
  readonly almacen: AlmacenMemoria;
  readonly cola: ColaMemoria;
  readonly guardrail: GuardrailPromptInjection;
  readonly llm: LlmPuerto;
  readonly herramientas: RegistroHerramientas;
  readonly motor: MotorAgente;
  readonly iniciar: IniciarEjecucionCasoUso;
  readonly procesar: ProcesarEjecucionCasoUso;
  readonly resolver: ResolverAprobacionCasoUso;
  readonly consultas: ConsultasCasoUso;
}

export function crearEntorno(opciones: { llm?: LlmPuerto; maxPasos?: number } = {}): Entorno {
  const reloj = new RelojFijo();
  const ids = new GeneradorIdSecuencial();
  const flujos = new FlujoMemoria([FLUJO_PRUEBA, FLUJO_RESTRINGIDO]);
  const ejecuciones = new EjecucionMemoria();
  const pasos = new PasoMemoria();
  const aprobaciones = new AprobacionMemoria();
  const catalogo = new CatalogoMemoria(CATALOGO_SEMILLA);
  const auditoria = new AuditoriaMemoria();
  const notificador = new NotificadorMemoria();
  const almacen = new AlmacenMemoria();
  const cola = new ColaMemoria();
  const guardrail = new GuardrailPromptInjection();
  const llm: LlmPuerto = opciones.llm ?? new LlmGuionado([]);
  const herramientas = crearRegistroHerramientas({ catalogo, notificador, almacen, ids, reloj, ejecuciones, aprobaciones, flujos, auditoria });
  const motor = new MotorAgente(
    { ejecuciones, pasos, aprobaciones, flujos, llm, herramientas, guardrail, auditoria, reloj, ids },
    opciones.maxPasos,
  );
  return {
    reloj,
    ids,
    flujos,
    ejecuciones,
    pasos,
    aprobaciones,
    catalogo,
    auditoria,
    notificador,
    almacen,
    cola,
    guardrail,
    llm,
    herramientas,
    motor,
    iniciar: new IniciarEjecucionCasoUso(flujos, ejecuciones, cola, guardrail, auditoria, reloj, ids),
    procesar: new ProcesarEjecucionCasoUso(motor),
    resolver: new ResolverAprobacionCasoUso(aprobaciones, motor, auditoria, reloj),
    consultas: new ConsultasCasoUso(ejecuciones, pasos, aprobaciones),
  };
}

export async function sembrarEjecucion(
  env: Entorno,
  entrada: JsonObjeto,
  flujo: FlujoDefinicion = FLUJO_PRUEBA,
): Promise<EjecucionAgente> {
  const ejecucion = EjecucionAgente.crear({
    id: env.ids.nuevo(),
    flujoId: flujo.id,
    origen: 'API',
    entrada,
    correlationId: 'corr-prueba-001',
    ahora: env.reloj.ahora(),
  });
  await env.ejecuciones.guardar(ejecucion);
  return ejecucion;
}
