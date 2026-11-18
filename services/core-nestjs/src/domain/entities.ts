// Dominio puro: sin imports de @nestjs/*, ORMs ni librerías de infraestructura.

// ============================== Tipos base ==============================
export type JsonValor = string | number | boolean | null | JsonValor[] | { [clave: string]: JsonValor };
export type JsonObjeto = { [clave: string]: JsonValor };

export type EstadoEjecucion =
  | 'PENDIENTE'
  | 'EN_EJECUCION'
  | 'PAUSADA_APROBACION'
  | 'COMPLETADA'
  | 'RECHAZADA'
  | 'FALLIDA';
export type OrigenEjecucion = 'API' | 'WEBHOOK' | 'CONSOLA';
export type EstadoPaso = 'PENDIENTE' | 'EN_EJECUCION' | 'COMPLETADO' | 'BLOQUEADO' | 'FALLIDO';
export type EstadoAprobacion = 'PENDIENTE' | 'APROBADA' | 'RECHAZADA' | 'EXPIRADA';
export type SeveridadAuditoria = 'INFO' | 'WARN' | 'ALTA' | 'CRITICA';

export const NOMBRES_HERRAMIENTA = [
  'consultar_proveedores',
  'consultar_catalogo',
  'validar_umbral_presupuestario',
  'emitir_propuesta_comercial',
  'notificar',
] as const;
export type NombreHerramienta = (typeof NOMBRES_HERRAMIENTA)[number];

export function esNombreHerramienta(valor: string): valor is NombreHerramienta {
  return (NOMBRES_HERRAMIENTA as readonly string[]).includes(valor);
}

// ============================== Errores de dominio ==============================
export class ErrorDominio extends Error {
  constructor(
    readonly codigo: string,
    mensaje: string,
    readonly detalle: Record<string, unknown> = {},
  ) {
    super(mensaje);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ErrorValidacion extends ErrorDominio {
  constructor(mensaje: string, detalle: Record<string, unknown> = {}) {
    super('VALIDACION', mensaje, detalle);
  }
}

export class ErrorNoEncontrado extends ErrorDominio {
  constructor(entidad: string, id: string) {
    super('NO_ENCONTRADO', `${entidad} no encontrada`, { entidad, id });
  }
}

export class ErrorTransicionInvalida extends ErrorDominio {
  constructor(entidad: string, desde: string, hacia: string) {
    super('TRANSICION_INVALIDA', `Transición no permitida en ${entidad}: ${desde} -> ${hacia}`, {
      entidad,
      desde,
      hacia,
    });
  }
}

export class ErrorInyeccionPrompt extends ErrorDominio {
  constructor(contexto: string, reglas: readonly string[], puntaje: number) {
    super('PROMPT_INJECTION', 'Contenido bloqueado por el guardrail anti-prompt-injection', {
      contexto,
      reglas: [...reglas],
      puntaje,
    });
  }
}

// ============================== Value Object: Dinero ==============================
const MAX_USD = 1_000_000_000;

export class Dinero {
  private constructor(readonly centavos: number) {}

  static deUsd(valor: number): Dinero {
    if (typeof valor !== 'number' || !Number.isFinite(valor) || valor < 0 || valor > MAX_USD) {
      throw new ErrorValidacion('Monto en USD inválido', { valor });
    }
    return new Dinero(Math.round(valor * 100));
  }

  static cero(): Dinero {
    return new Dinero(0);
  }

  get usd(): number {
    return this.centavos / 100;
  }

  sumar(otro: Dinero): Dinero {
    return new Dinero(this.centavos + otro.centavos);
  }

  multiplicar(cantidad: number): Dinero {
    if (!Number.isInteger(cantidad) || cantidad < 0) {
      throw new ErrorValidacion('Cantidad inválida', { cantidad });
    }
    return new Dinero(this.centavos * cantidad);
  }

  superaA(otro: Dinero): boolean {
    return this.centavos > otro.centavos;
  }
}

// ============================== Definición de flujo y catálogo ==============================
export interface FlujoDefinicion {
  readonly id: string;
  readonly nombre: string;
  readonly descripcion: string;
  readonly version: number;
  readonly herramientasPermitidas: readonly NombreHerramienta[];
  readonly umbralAprobacion: Dinero;
  readonly activo: boolean;
}

export interface ProveedorCatalogo {
  readonly id: string;
  readonly nombre: string;
  readonly categoria: string;
  readonly sku: string;
  readonly descripcion: string;
  readonly precioUnitarioUsd: number;
  readonly plazoEntregaDias: number;
  readonly calificacion: number;
  readonly pais: string;
  readonly activo: boolean;
}

export interface EventoAuditoria {
  readonly tipoEvento: string;
  readonly severidad: SeveridadAuditoria;
  readonly actor: string | null;
  readonly ipOrigen: string | null;
  readonly correlationId: string | null;
  readonly detalle: JsonObjeto;
}

// ============================== Entidad: EjecucionAgente ==============================
const TRANSICIONES_EJECUCION: Readonly<Record<EstadoEjecucion, readonly EstadoEjecucion[]>> = {
  PENDIENTE: ['EN_EJECUCION', 'RECHAZADA', 'FALLIDA'],
  EN_EJECUCION: ['PAUSADA_APROBACION', 'COMPLETADA', 'RECHAZADA', 'FALLIDA'],
  PAUSADA_APROBACION: ['EN_EJECUCION', 'RECHAZADA', 'FALLIDA'],
  COMPLETADA: [],
  RECHAZADA: [],
  FALLIDA: [],
};
const ESTADOS_TERMINALES_EJECUCION: ReadonlySet<EstadoEjecucion> = new Set<EstadoEjecucion>([
  'COMPLETADA',
  'RECHAZADA',
  'FALLIDA',
]);

export interface EjecucionProps {
  id: string;
  flujoId: string;
  estado: EstadoEjecucion;
  origen: OrigenEjecucion;
  entrada: JsonObjeto;
  resultado: JsonObjeto | null;
  error: string | null;
  correlationId: string;
  iniciadoEn: Date;
  finalizadoEn: Date | null;
}

export class EjecucionAgente {
  private constructor(private datos: EjecucionProps) {}

  static crear(p: {
    id: string;
    flujoId: string;
    origen: OrigenEjecucion;
    entrada: JsonObjeto;
    correlationId: string;
    ahora: Date;
  }): EjecucionAgente {
    const correlacion = p.correlationId.trim();
    if (correlacion.length === 0 || correlacion.length > 64) {
      throw new ErrorValidacion('correlationId inválido (1-64 caracteres)');
    }
    return new EjecucionAgente({
      id: p.id,
      flujoId: p.flujoId,
      estado: 'PENDIENTE',
      origen: p.origen,
      entrada: p.entrada,
      resultado: null,
      error: null,
      correlationId: correlacion,
      iniciadoEn: p.ahora,
      finalizadoEn: null,
    });
  }

  static rehidratar(datos: EjecucionProps): EjecucionAgente {
    return new EjecucionAgente({ ...datos });
  }

  get id(): string {
    return this.datos.id;
  }
  get flujoId(): string {
    return this.datos.flujoId;
  }
  get estado(): EstadoEjecucion {
    return this.datos.estado;
  }
  get entrada(): JsonObjeto {
    return this.datos.entrada;
  }
  get correlationId(): string {
    return this.datos.correlationId;
  }

  snapshot(): EjecucionProps {
    return { ...this.datos };
  }

  iniciar(ahora: Date): void {
    this.mover('EN_EJECUCION', ahora);
  }

  pausarPorAprobacion(ahora: Date): void {
    this.mover('PAUSADA_APROBACION', ahora);
  }

  reanudar(ahora: Date): void {
    this.mover('EN_EJECUCION', ahora);
  }

  completar(resultado: JsonObjeto, ahora: Date): void {
    this.mover('COMPLETADA', ahora);
    this.datos.resultado = resultado;
  }

  rechazar(motivo: string, ahora: Date): void {
    this.mover('RECHAZADA', ahora);
    this.datos.error = motivo.slice(0, 1000);
  }

  fallar(error: string, ahora: Date): void {
    this.mover('FALLIDA', ahora);
    this.datos.error = error.slice(0, 1000);
  }

  private mover(destino: EstadoEjecucion, ahora: Date): void {
    if (!TRANSICIONES_EJECUCION[this.datos.estado].includes(destino)) {
      throw new ErrorTransicionInvalida('ejecucion', this.datos.estado, destino);
    }
    this.datos.estado = destino;
    if (ESTADOS_TERMINALES_EJECUCION.has(destino)) {
      this.datos.finalizadoEn = ahora;
    }
  }
}

// ============================== Entidad: PasoEjecucion ==============================
const TRANSICIONES_PASO: Readonly<Record<EstadoPaso, readonly EstadoPaso[]>> = {
  PENDIENTE: ['EN_EJECUCION', 'BLOQUEADO', 'FALLIDO'],
  EN_EJECUCION: ['COMPLETADO', 'BLOQUEADO', 'FALLIDO'],
  COMPLETADO: [],
  BLOQUEADO: [],
  FALLIDO: [],
};

export interface PasoProps {
  id: string;
  ejecucionId: string;
  orden: number;
  herramienta: string;
  razonamiento: string | null;
  entrada: JsonObjeto;
  salida: JsonObjeto | null;
  estado: EstadoPaso;
  error: string | null;
  duracionMs: number | null;
  creadoEn: Date;
}

export class PasoEjecucion {
  private constructor(private datos: PasoProps) {}

  static crear(p: {
    id: string;
    ejecucionId: string;
    orden: number;
    herramienta: string;
    razonamiento: string | null;
    entrada: JsonObjeto;
    ahora: Date;
  }): PasoEjecucion {
    if (!Number.isInteger(p.orden) || p.orden < 1) {
      throw new ErrorValidacion('Orden de paso inválido', { orden: p.orden });
    }
    return new PasoEjecucion({
      id: p.id,
      ejecucionId: p.ejecucionId,
      orden: p.orden,
      herramienta: p.herramienta.slice(0, 80),
      razonamiento: p.razonamiento,
      entrada: p.entrada,
      salida: null,
      estado: 'PENDIENTE',
      error: null,
      duracionMs: null,
      creadoEn: p.ahora,
    });
  }

  static rehidratar(datos: PasoProps): PasoEjecucion {
    return new PasoEjecucion({ ...datos });
  }

  get id(): string {
    return this.datos.id;
  }
  get ejecucionId(): string {
    return this.datos.ejecucionId;
  }
  get orden(): number {
    return this.datos.orden;
  }
  get herramienta(): string {
    return this.datos.herramienta;
  }
  get entrada(): JsonObjeto {
    return this.datos.entrada;
  }
  get salida(): JsonObjeto | null {
    return this.datos.salida;
  }
  get estado(): EstadoPaso {
    return this.datos.estado;
  }

  snapshot(): PasoProps {
    return { ...this.datos };
  }

  iniciar(): void {
    this.mover('EN_EJECUCION');
  }

  completar(salida: JsonObjeto, duracionMs: number): void {
    this.mover('COMPLETADO');
    this.datos.salida = salida;
    this.datos.duracionMs = Math.max(0, Math.round(duracionMs));
  }

  bloquear(motivo: string): void {
    this.mover('BLOQUEADO');
    this.datos.error = motivo.slice(0, 1000);
  }

  fallar(error: string, duracionMs: number): void {
    this.mover('FALLIDO');
    this.datos.error = error.slice(0, 1000);
    this.datos.duracionMs = Math.max(0, Math.round(duracionMs));
  }

  private mover(destino: EstadoPaso): void {
    if (!TRANSICIONES_PASO[this.datos.estado].includes(destino)) {
      throw new ErrorTransicionInvalida('paso', this.datos.estado, destino);
    }
    this.datos.estado = destino;
  }
}

// ============================== Entidad: AprobacionHumana ==============================
export interface AprobacionProps {
  id: string;
  ejecucionId: string;
  pasoId: string | null;
  accionPropuesta: JsonObjeto;
  motivo: string;
  montoUsd: number | null;
  estado: EstadoAprobacion;
  solicitadoEn: Date;
  resueltoEn: Date | null;
  resueltoPor: string | null;
  comentario: string | null;
}

export class AprobacionHumana {
  private constructor(private datos: AprobacionProps) {}

  static crear(p: {
    id: string;
    ejecucionId: string;
    pasoId: string | null;
    accionPropuesta: JsonObjeto;
    motivo: string;
    montoUsd: number | null;
    ahora: Date;
  }): AprobacionHumana {
    return new AprobacionHumana({
      id: p.id,
      ejecucionId: p.ejecucionId,
      pasoId: p.pasoId,
      accionPropuesta: p.accionPropuesta,
      motivo: p.motivo.slice(0, 1000),
      montoUsd: p.montoUsd,
      estado: 'PENDIENTE',
      solicitadoEn: p.ahora,
      resueltoEn: null,
      resueltoPor: null,
      comentario: null,
    });
  }

  static rehidratar(datos: AprobacionProps): AprobacionHumana {
    return new AprobacionHumana({ ...datos });
  }

  get id(): string {
    return this.datos.id;
  }
  get ejecucionId(): string {
    return this.datos.ejecucionId;
  }
  get pasoId(): string | null {
    return this.datos.pasoId;
  }
  get estado(): EstadoAprobacion {
    return this.datos.estado;
  }
  get resueltoPor(): string | null {
    return this.datos.resueltoPor;
  }

  snapshot(): AprobacionProps {
    return { ...this.datos };
  }

  aprobar(usuario: string, comentario: string | null, ahora: Date): void {
    this.resolver('APROBADA', usuario, comentario, ahora);
  }

  rechazar(usuario: string, comentario: string | null, ahora: Date): void {
    this.resolver('RECHAZADA', usuario, comentario, ahora);
  }

  private resolver(
    destino: 'APROBADA' | 'RECHAZADA',
    usuario: string,
    comentario: string | null,
    ahora: Date,
  ): void {
    if (this.datos.estado !== 'PENDIENTE') {
      throw new ErrorTransicionInvalida('aprobacion', this.datos.estado, destino);
    }
    this.datos.estado = destino;
    this.datos.resueltoEn = ahora;
    this.datos.resueltoPor = usuario.slice(0, 120);
    this.datos.comentario = comentario;
  }
}
