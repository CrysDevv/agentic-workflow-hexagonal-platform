import {
  ErrorValidacion,
  esNombreHerramienta,
  type Dinero,
  type FlujoDefinicion,
  type JsonObjeto,
  type NombreHerramienta,
} from '../../domain/entities';
import type {
  AlmacenPropuestasPuerto,
  CatalogoProveedoresRepositorio,
  GeneradorIdPuerto,
  NotificadorPuerto,
  RelojPuerto,
} from '../../domain/ports';

// ============================== Contratos ==============================
export interface DependenciasHerramientas {
  readonly catalogo: CatalogoProveedoresRepositorio;
  readonly notificador: NotificadorPuerto;
  readonly almacen: AlmacenPropuestasPuerto;
  readonly ids: GeneradorIdPuerto;
  readonly reloj: RelojPuerto;
}

export interface ContextoHerramienta {
  readonly ejecucionId: string;
  readonly correlationId: string;
  readonly flujo: FlujoDefinicion;
}

export interface DefinicionHerramienta<I, O> {
  readonly nombre: NombreHerramienta;
  readonly descripcion: string;
  /** Una herramienta crítica puede requerir aprobación humana según el monto estimado. */
  readonly critica: boolean;
  validarEntrada(cruda: unknown): I;
  estimarMonto?(entrada: I, ctx: ContextoHerramienta): Promise<Dinero>;
  ejecutar(entrada: I, ctx: ContextoHerramienta): Promise<O>;
}

export interface PreparacionHerramienta {
  /** Entrada validada y normalizada (lo que el humano ve y aprueba). */
  readonly entrada: JsonObjeto;
  readonly monto: Dinero | null;
  ejecutar(): Promise<JsonObjeto>;
}

export interface HerramientaRegistrada {
  readonly nombre: NombreHerramienta;
  readonly descripcion: string;
  readonly critica: boolean;
  preparar(entradaCruda: unknown, ctx: ContextoHerramienta): Promise<PreparacionHerramienta>;
}

// ============================== Validadores de entrada ==============================
export interface OpcionesNumero {
  min?: number;
  max?: number;
  entero?: boolean;
}

export function exigirObjeto(valor: unknown, campo: string): Record<string, unknown> {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
    throw new ErrorValidacion(`'${campo}' debe ser un objeto`, { campo });
  }
  return valor as Record<string, unknown>;
}

export function exigirTexto(valor: unknown, campo: string, max = 500, min = 1): string {
  if (typeof valor !== 'string') {
    throw new ErrorValidacion(`'${campo}' debe ser texto`, { campo });
  }
  const limpio = valor.trim();
  if (limpio.length < min || limpio.length > max) {
    throw new ErrorValidacion(`'${campo}' debe tener entre ${min} y ${max} caracteres`, { campo });
  }
  return limpio;
}

export function textoOpcional(valor: unknown, campo: string, max = 500): string | undefined {
  if (valor === undefined || valor === null) return undefined;
  return exigirTexto(valor, campo, max);
}

export function exigirNumero(valor: unknown, campo: string, opciones: OpcionesNumero = {}): number {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) {
    throw new ErrorValidacion(`'${campo}' debe ser numérico`, { campo });
  }
  if (opciones.entero === true && !Number.isInteger(valor)) {
    throw new ErrorValidacion(`'${campo}' debe ser entero`, { campo });
  }
  if (opciones.min !== undefined && valor < opciones.min) {
    throw new ErrorValidacion(`'${campo}' debe ser >= ${opciones.min}`, { campo });
  }
  if (opciones.max !== undefined && valor > opciones.max) {
    throw new ErrorValidacion(`'${campo}' debe ser <= ${opciones.max}`, { campo });
  }
  return valor;
}

export function numeroOpcional(
  valor: unknown,
  campo: string,
  opciones: OpcionesNumero,
  porDefecto: number,
): number {
  if (valor === undefined || valor === null) return porDefecto;
  return exigirNumero(valor, campo, opciones);
}

export function exigirArreglo(valor: unknown, campo: string, min: number, max: number): unknown[] {
  if (!Array.isArray(valor) || valor.length < min || valor.length > max) {
    throw new ErrorValidacion(`'${campo}' debe ser un arreglo de ${min} a ${max} elementos`, { campo });
  }
  return valor as unknown[];
}

function aJson(valor: unknown): JsonObjeto {
  return JSON.parse(JSON.stringify(valor ?? {})) as JsonObjeto;
}

// ============================== Registro tipado ==============================
export class RegistroHerramientas {
  private readonly mapa = new Map<NombreHerramienta, HerramientaRegistrada>();

  registrar<I, O>(definicion: DefinicionHerramienta<I, O>): this {
    if (this.mapa.has(definicion.nombre)) {
      throw new Error(`Herramienta duplicada: ${definicion.nombre}`);
    }
    this.mapa.set(definicion.nombre, {
      nombre: definicion.nombre,
      descripcion: definicion.descripcion,
      critica: definicion.critica,
      async preparar(entradaCruda: unknown, ctx: ContextoHerramienta): Promise<PreparacionHerramienta> {
        const entrada = definicion.validarEntrada(entradaCruda);
        const monto = definicion.estimarMonto ? await definicion.estimarMonto(entrada, ctx) : null;
        return {
          entrada: aJson(entrada),
          monto,
          ejecutar: async (): Promise<JsonObjeto> => aJson(await definicion.ejecutar(entrada, ctx)),
        };
      },
    });
    return this;
  }

  obtener(nombre: string): HerramientaRegistrada | undefined {
    return esNombreHerramienta(nombre) ? this.mapa.get(nombre) : undefined;
  }

  disponiblesPara(permitidas: readonly NombreHerramienta[]): HerramientaRegistrada[] {
    const resultado: HerramientaRegistrada[] = [];
    for (const nombre of permitidas) {
      const herramienta = this.mapa.get(nombre);
      if (herramienta) resultado.push(herramienta);
    }
    return resultado;
  }
}
