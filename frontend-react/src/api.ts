declare global {
  interface Window {
    __CONFIG__?: { apiBaseUrl?: string };
  }
}

// ============================== Tipos del contrato REST ==============================
export type EstadoEjecucion = 'PENDIENTE' | 'EN_EJECUCION' | 'PAUSADA_APROBACION' | 'COMPLETADA' | 'RECHAZADA' | 'FALLIDA';
export type EstadoPaso = 'PENDIENTE' | 'EN_EJECUCION' | 'COMPLETADO' | 'BLOQUEADO' | 'FALLIDO';
export type EstadoAprobacion = 'PENDIENTE' | 'APROBADA' | 'RECHAZADA' | 'EXPIRADA';

export interface Ejecucion {
  id: string;
  flujoId: string;
  estado: EstadoEjecucion;
  origen: 'API' | 'WEBHOOK' | 'CONSOLA';
  entrada: Record<string, unknown>;
  resultado: Record<string, unknown> | null;
  error: string | null;
  correlationId: string;
  iniciadoEn: string;
  finalizadoEn: string | null;
}

export interface Paso {
  id: string;
  ejecucionId: string;
  orden: number;
  herramienta: string;
  razonamiento: string | null;
  entrada: Record<string, unknown>;
  salida: Record<string, unknown> | null;
  estado: EstadoPaso;
  error: string | null;
  duracionMs: number | null;
  creadoEn: string;
}

export interface Aprobacion {
  id: string;
  ejecucionId: string;
  pasoId: string | null;
  accionPropuesta: Record<string, unknown>;
  motivo: string;
  montoUsd: number | null;
  estado: EstadoAprobacion;
  solicitadoEn: string;
  resueltoEn: string | null;
  resueltoPor: string | null;
  comentario: string | null;
}

export interface Traza {
  ejecucion: Ejecucion;
  pasos: Paso[];
  aprobaciones: Aprobacion[];
}

export interface Firma {
  timestamp: string;
  firma: string;
  cuerpoCanonico: string;
}

/** Cuerpo `application/problem+json` (RFC 7807) emitido por el backend. */
export interface Problema {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  correlationId?: string | null;
  reglas?: string[];
  puntaje?: number;
  campo?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problema: Problema,
    readonly correlationId: string | null,
  ) {
    super(problema.detail ?? problema.title ?? `Error ${status}`);
    this.name = 'ApiError';
  }
}

export function esRegistro(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

// ============================== Cliente HTTP ==============================
const baseEnv: string = import.meta.env.VITE_API_BASE_URL ?? '';
const BASE = (window.__CONFIG__?.apiBaseUrl || baseEnv || 'http://localhost:3000').replace(/\/+$/, '');
const TIEMPO_MAX_MS = 15_000;

export function nuevaCorrelacion(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export interface OpcionesCruda {
  metodo?: 'GET' | 'POST';
  apiKey?: string;
  cabeceras?: Record<string, string>;
  /** Cuerpo exacto a enviar (se respeta byte a byte; necesario para firmas HMAC). */
  cuerpoTexto?: string;
}

export interface RespuestaCruda {
  status: number;
  ok: boolean;
  cuerpo: unknown;
  texto: string;
  correlationId: string | null;
  contentType: string;
}

export async function solicitudCruda(ruta: string, opciones: OpcionesCruda = {}): Promise<RespuestaCruda> {
  const cabeceras: Record<string, string> = {
    Accept: 'application/json, application/problem+json',
    'X-Correlation-ID': nuevaCorrelacion(),
    ...(opciones.cabeceras ?? {}),
  };
  if (opciones.apiKey !== undefined && opciones.apiKey !== '') cabeceras['X-API-Key'] = opciones.apiKey;
  if (opciones.cuerpoTexto !== undefined) cabeceras['Content-Type'] = 'application/json';

  let respuesta: Response;
  try {
    respuesta = await fetch(`${BASE}${ruta}`, {
      method: opciones.metodo ?? 'GET',
      headers: cabeceras,
      body: opciones.cuerpoTexto,
      signal: AbortSignal.timeout(TIEMPO_MAX_MS),
    });
  } catch (error) {
    throw new ApiError(
      0,
      { title: 'Sin conexión con la API', detail: error instanceof Error ? error.message : 'Error de red' },
      null,
    );
  }

  const texto = await respuesta.text();
  let cuerpo: unknown = null;
  try {
    cuerpo = texto === '' ? null : JSON.parse(texto);
  } catch {
    cuerpo = null;
  }
  return {
    status: respuesta.status,
    ok: respuesta.ok,
    cuerpo,
    texto,
    correlationId: respuesta.headers.get('x-correlation-id'),
    contentType: respuesta.headers.get('content-type') ?? '',
  };
}

async function solicitar<T>(
  ruta: string,
  apiKey: string,
  metodo: 'GET' | 'POST' = 'GET',
  cuerpo?: unknown,
): Promise<T> {
  const r = await solicitudCruda(ruta, {
    apiKey,
    metodo,
    cuerpoTexto: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  if (!r.ok) {
    const problema: Problema = esRegistro(r.cuerpo)
      ? (r.cuerpo as Problema)
      : { title: `Error ${r.status}`, detail: r.texto.slice(0, 200) };
    throw new ApiError(r.status, problema, r.correlationId);
  }
  return r.cuerpo as T;
}

export const api = {
  listarEjecuciones: (apiKey: string): Promise<Ejecucion[]> => solicitar<Ejecucion[]>('/ejecuciones?limite=50', apiKey),
  traza: (apiKey: string, id: string): Promise<Traza> =>
    solicitar<Traza>(`/ejecuciones/${encodeURIComponent(id)}/traza`, apiKey),
  pendientes: (apiKey: string): Promise<Aprobacion[]> =>
    solicitar<Aprobacion[]>('/aprobaciones/pendientes?limite=50', apiKey),
  resolver: (apiKey: string, id: string, decision: 'APROBAR' | 'RECHAZAR', comentario: string): Promise<Ejecucion> =>
    solicitar<Ejecucion>(`/aprobaciones/${encodeURIComponent(id)}/resolver`, apiKey, 'POST', {
      decision,
      ...(comentario.trim() === '' ? {} : { comentario: comentario.trim() }),
    }),
  iniciar: (apiKey: string, flujo: string, entrada: Record<string, unknown>): Promise<Ejecucion> =>
    solicitar<Ejecucion>('/ejecuciones', apiKey, 'POST', { flujo, entrada }),
  firmar: (apiKey: string, cuerpo: Record<string, unknown>): Promise<Firma> =>
    solicitar<Firma>('/webhooks/simulador/firmar', apiKey, 'POST', { cuerpo }),
};
