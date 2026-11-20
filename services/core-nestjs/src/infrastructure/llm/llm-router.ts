import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { GuardrailPromptInjection } from '../../application/guardrails/prompt-injection.guardrail';
import { ErrorValidacion } from '../../domain/entities';
import type { ContextoRazonamiento, DecisionAgente, LlmPuerto } from '../../domain/ports';
import { LlmAnthropic, LlmLocalDeterminista } from './llm.adapters';
import { LlmOllama } from './ollama.adapter';

// ============================== Tipos ==============================
export const PROVEEDORES_LLM = ['local-deterministic', 'ollama', 'anthropic'] as const;
export type ProveedorLlm = (typeof PROVEEDORES_LLM)[number];

export function esProveedor(valor: string): valor is ProveedorLlm {
  return (PROVEEDORES_LLM as readonly string[]).includes(valor);
}

export interface ConfigLlm {
  readonly proveedor: ProveedorLlm;
  readonly anthropicModel: string;
  readonly ollamaBaseUrl: string;
  readonly ollamaModel: string;
}

export interface DefectoLlm {
  readonly provider: ProveedorLlm;
  readonly anthropicApiKey: string;
  readonly anthropicModel: string;
  readonly ollamaBaseUrl: string;
  readonly ollamaModel: string;
}

export type OrigenClave = 'interfaz' | 'entorno' | 'ninguna';

export interface VistaConfigLlm extends ConfigLlm {
  readonly anthropicKeyConfigurada: boolean;
  readonly origenClave: OrigenClave;
}

export interface CambioConfigLlm {
  proveedor?: ProveedorLlm;
  anthropicModel?: string;
  anthropicApiKey?: string;
  borrarAnthropicKey?: boolean;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
}

export interface ResultadoPrueba {
  readonly ok: boolean;
  readonly mensaje: string;
  readonly modelos?: string[];
}

interface Guardado extends ConfigLlm {
  readonly anthropicKeyCifrada: string | null;
}

interface Efectiva {
  readonly config: ConfigLlm;
  readonly apiKey: string;
  readonly origenClave: OrigenClave;
}

// ============================== Cifrado de la API Key (AES-256-GCM) ==============================
function derivarClave(secreto: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secreto, 'agentic-config-llm', 'aes-256-gcm', 32));
}

export function cifrar(texto: string, secreto: string): string {
  const iv = randomBytes(12);
  const cifrador = createCipheriv('aes-256-gcm', derivarClave(secreto), iv);
  const datos = Buffer.concat([cifrador.update(texto, 'utf8'), cifrador.final()]);
  return ['v1', iv.toString('base64'), cifrador.getAuthTag().toString('base64'), datos.toString('base64')].join('.');
}

export function descifrar(valor: string, secreto: string): string | null {
  const partes = valor.split('.');
  if (partes.length !== 4 || partes[0] !== 'v1') return null;
  try {
    const descifrador = createDecipheriv('aes-256-gcm', derivarClave(secreto), Buffer.from(partes[1] as string, 'base64'));
    descifrador.setAuthTag(Buffer.from(partes[2] as string, 'base64'));
    return Buffer.concat([descifrador.update(Buffer.from(partes[3] as string, 'base64')), descifrador.final()]).toString(
      'utf8',
    );
  } catch {
    return null;
  }
}

// ============================== Validación ==============================
const PATRON_MODELO_ANTHROPIC = /^[A-Za-z0-9._-]{1,80}$/;
const PATRON_MODELO_OLLAMA = /^[A-Za-z0-9._:/-]{1,100}$/;

export function validarUrlOllama(crudo: string): string {
  let url: URL;
  try {
    url = new URL(crudo.trim());
  } catch {
    throw new ErrorValidacion("'ollamaBaseUrl' no es una URL válida", { campo: 'ollamaBaseUrl' });
  }
  const invalida =
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.hostname.startsWith('169.254.') ||
    url.hostname === 'metadata.google.internal';
  if (invalida) {
    throw new ErrorValidacion("'ollamaBaseUrl' debe ser una URL http(s) sin credenciales ni direcciones de metadatos", {
      campo: 'ollamaBaseUrl',
    });
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

export function parsearCambio(cuerpo: unknown): CambioConfigLlm {
  if (typeof cuerpo !== 'object' || cuerpo === null || Array.isArray(cuerpo)) {
    throw new ErrorValidacion('El cuerpo debe ser un objeto', { campo: 'cuerpo' });
  }
  const o = cuerpo as Record<string, unknown>;
  const texto = (campo: string, max: number): string | undefined => {
    const v = o[campo];
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string') throw new ErrorValidacion(`'${campo}' debe ser texto`, { campo });
    const limpio = v.trim();
    if (limpio.length === 0 || limpio.length > max) {
      throw new ErrorValidacion(`'${campo}' debe tener entre 1 y ${max} caracteres`, { campo });
    }
    return limpio;
  };

  const cambio: CambioConfigLlm = {};
  const proveedor = texto('proveedor', 40);
  if (proveedor !== undefined) {
    if (!esProveedor(proveedor)) {
      throw new ErrorValidacion(`'proveedor' debe ser ${PROVEEDORES_LLM.join(', ')}`, { campo: 'proveedor' });
    }
    cambio.proveedor = proveedor;
  }
  const modeloAnthropic = texto('anthropicModel', 80);
  if (modeloAnthropic !== undefined) {
    if (!PATRON_MODELO_ANTHROPIC.test(modeloAnthropic)) {
      throw new ErrorValidacion("'anthropicModel' contiene caracteres no permitidos", { campo: 'anthropicModel' });
    }
    cambio.anthropicModel = modeloAnthropic;
  }
  const clave = texto('anthropicApiKey', 300);
  if (clave !== undefined) {
    if (clave.length < 20 || /\s/.test(clave)) {
      throw new ErrorValidacion("'anthropicApiKey' no parece una API Key válida", { campo: 'anthropicApiKey' });
    }
    cambio.anthropicApiKey = clave;
  }
  if (o['borrarAnthropicKey'] === true) cambio.borrarAnthropicKey = true;
  const url = texto('ollamaBaseUrl', 300);
  if (url !== undefined) cambio.ollamaBaseUrl = validarUrlOllama(url);
  const modeloOllama = texto('ollamaModel', 100);
  if (modeloOllama !== undefined) {
    if (!PATRON_MODELO_OLLAMA.test(modeloOllama)) {
      throw new ErrorValidacion("'ollamaModel' contiene caracteres no permitidos", { campo: 'ollamaModel' });
    }
    cambio.ollamaModel = modeloOllama;
  }
  return cambio;
}

function parsearGuardado(crudo: string | null): Guardado | null {
  if (crudo === null) return null;
  try {
    const v: unknown = JSON.parse(crudo);
    if (typeof v !== 'object' || v === null) return null;
    const o = v as Record<string, unknown>;
    const proveedor = o['proveedor'];
    const modeloAnthropic = o['anthropicModel'];
    const urlOllama = o['ollamaBaseUrl'];
    const modeloOllama = o['ollamaModel'];
    const clave = o['anthropicKeyCifrada'];
    if (typeof proveedor !== 'string' || !esProveedor(proveedor)) return null;
    if (typeof modeloAnthropic !== 'string' || typeof urlOllama !== 'string' || typeof modeloOllama !== 'string') {
      return null;
    }
    return {
      proveedor,
      anthropicModel: modeloAnthropic,
      ollamaBaseUrl: validarUrlOllama(urlOllama),
      ollamaModel: modeloOllama,
      anthropicKeyCifrada: typeof clave === 'string' ? clave : null,
    };
  } catch {
    return null;
  }
}

function extraerNombresModelos(cuerpo: unknown): string[] {
  if (typeof cuerpo !== 'object' || cuerpo === null) return [];
  const lista = (cuerpo as Record<string, unknown>)['models'];
  if (!Array.isArray(lista)) return [];
  const nombres: string[] = [];
  for (const m of lista as unknown[]) {
    if (typeof m === 'object' && m !== null) {
      const nombre = (m as Record<string, unknown>)['name'];
      if (typeof nombre === 'string') nombres.push(nombre);
    }
  }
  return nombres.sort();
}

// ============================== Almacenamiento compartido entre réplicas ==============================
export interface AlmacenConfigLlm {
  leer(): Promise<string | null>;
  guardar(valor: string): Promise<void>;
}

const CLAVE_REDIS = 'agentic:config:llm';

export class RedisAlmacenConfigLlm implements AlmacenConfigLlm {
  constructor(private readonly redis: Redis) {}

  leer(): Promise<string | null> {
    return this.redis.get(CLAVE_REDIS);
  }

  async guardar(valor: string): Promise<void> {
    await this.redis.set(CLAVE_REDIS, valor);
  }
}

// ============================== Servicio de configuración ==============================
export class ServicioConfigLlm {
  private readonly log = new Logger('ConfigLlm');
  private cache: { readonly efectiva: Efectiva; readonly expira: number } | null = null;

  constructor(
    private readonly defecto: DefectoLlm,
    private readonly almacen: AlmacenConfigLlm,
    private readonly secreto: string,
    private readonly ttlMs: number = 3000,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Configuración vigente (valores por defecto del entorno o la última selección guardada desde la interfaz). */
  async efectiva(): Promise<Efectiva> {
    const ahora = Date.now();
    if (this.cache !== null && this.cache.expira > ahora) return this.cache.efectiva;
    let guardado: Guardado | null = null;
    try {
      guardado = await this.leerGuardado();
    } catch (error) {
      this.log.warn(`No se pudo leer la configuración del LLM: ${error instanceof Error ? error.message : 'error'}`);
      if (this.cache !== null) return this.cache.efectiva;
    }
    const efectiva = this.resolver(guardado);
    this.cache = { efectiva, expira: ahora + this.ttlMs };
    return efectiva;
  }

  async vista(): Promise<VistaConfigLlm> {
    const e = await this.efectiva();
    return { ...e.config, anthropicKeyConfigurada: e.apiKey !== '', origenClave: e.origenClave };
  }

  async actualizar(cambio: CambioConfigLlm): Promise<VistaConfigLlm> {
    if (cambio.proveedor === undefined) {
      throw new ErrorValidacion("'proveedor' es obligatorio", { campo: 'proveedor' });
    }
    const guardado = await this.leerGuardado();
    const actual = this.resolver(guardado);
    const config: ConfigLlm = {
      proveedor: cambio.proveedor,
      anthropicModel: cambio.anthropicModel ?? actual.config.anthropicModel,
      ollamaBaseUrl: cambio.ollamaBaseUrl ?? actual.config.ollamaBaseUrl,
      ollamaModel: cambio.ollamaModel ?? actual.config.ollamaModel,
    };

    let cifrada = guardado === null ? null : guardado.anthropicKeyCifrada;
    if (cambio.borrarAnthropicKey === true) cifrada = null;
    if (cambio.anthropicApiKey !== undefined) cifrada = cifrar(cambio.anthropicApiKey, this.secreto);

    const hayClave =
      (cifrada !== null && descifrar(cifrada, this.secreto) !== null) || this.defecto.anthropicApiKey !== '';
    if (config.proveedor === 'anthropic' && !hayClave) {
      throw new ErrorValidacion('Ingresa una API Key de Anthropic o elige otro proveedor', {
        campo: 'anthropicApiKey',
      });
    }

    const registro: Guardado = { ...config, anthropicKeyCifrada: cifrada };
    await this.almacen.guardar(JSON.stringify(registro));
    this.cache = null;
    return this.vista();
  }

  /** Comprueba la conectividad del proveedor indicado (sin persistir nada). */
  async probar(cambio: CambioConfigLlm): Promise<ResultadoPrueba> {
    const actual = await this.efectiva();
    const config: ConfigLlm = {
      proveedor: cambio.proveedor ?? actual.config.proveedor,
      anthropicModel: cambio.anthropicModel ?? actual.config.anthropicModel,
      ollamaBaseUrl: cambio.ollamaBaseUrl ?? actual.config.ollamaBaseUrl,
      ollamaModel: cambio.ollamaModel ?? actual.config.ollamaModel,
    };
    if (config.proveedor === 'local-deterministic') {
      return { ok: true, mensaje: 'Proveedor determinista local: no requiere conexión ni API Key.' };
    }
    if (config.proveedor === 'ollama') return this.probarOllama(config);
    return this.probarAnthropic(cambio.anthropicApiKey ?? actual.apiKey);
  }

  /** Lista los modelos descargados en un servidor Ollama. */
  async modelosOllama(baseUrl?: string): Promise<ResultadoPrueba> {
    const base =
      baseUrl === undefined || baseUrl.trim() === ''
        ? (await this.efectiva()).config.ollamaBaseUrl
        : validarUrlOllama(baseUrl);
    const r = await this.consultarOllama(base);
    if (!r.ok) return { ok: false, mensaje: r.mensaje, modelos: [] };
    return { ok: true, mensaje: `${r.modelos.length} modelo(s) detectado(s)`, modelos: r.modelos };
  }

  private async leerGuardado(): Promise<Guardado | null> {
    return parsearGuardado(await this.almacen.leer());
  }

  private resolver(guardado: Guardado | null): Efectiva {
    const config: ConfigLlm =
      guardado === null
        ? {
            proveedor: this.defecto.provider,
            anthropicModel: this.defecto.anthropicModel,
            ollamaBaseUrl: this.defecto.ollamaBaseUrl,
            ollamaModel: this.defecto.ollamaModel,
          }
        : {
            proveedor: guardado.proveedor,
            anthropicModel: guardado.anthropicModel,
            ollamaBaseUrl: guardado.ollamaBaseUrl,
            ollamaModel: guardado.ollamaModel,
          };
    const claveInterfaz =
      guardado !== null && guardado.anthropicKeyCifrada !== null
        ? descifrar(guardado.anthropicKeyCifrada, this.secreto)
        : null;
    if (claveInterfaz !== null) return { config, apiKey: claveInterfaz, origenClave: 'interfaz' };
    if (this.defecto.anthropicApiKey !== '') {
      return { config, apiKey: this.defecto.anthropicApiKey, origenClave: 'entorno' };
    }
    return { config, apiKey: '', origenClave: 'ninguna' };
  }

  private async consultarOllama(
    base: string,
  ): Promise<{ ok: true; modelos: string[] } | { ok: false; mensaje: string }> {
    try {
      const r = await this.fetchFn(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return { ok: false, mensaje: `Ollama respondió con estado ${r.status}` };
      return { ok: true, modelos: extraerNombresModelos(await r.json()) };
    } catch {
      return { ok: false, mensaje: `No se pudo conectar con Ollama en ${base}` };
    }
  }

  private async probarOllama(config: ConfigLlm): Promise<ResultadoPrueba> {
    const r = await this.consultarOllama(config.ollamaBaseUrl);
    if (!r.ok) return { ok: false, mensaje: r.mensaje };
    const presente = r.modelos.some((m) => m === config.ollamaModel || m === `${config.ollamaModel}:latest`);
    if (presente) {
      return { ok: true, mensaje: `Conexión correcta: el modelo ${config.ollamaModel} está disponible.`, modelos: r.modelos };
    }
    return {
      ok: false,
      mensaje: `Ollama responde, pero el modelo ${config.ollamaModel} no está descargado. Ejecuta: docker compose exec ollama ollama pull ${config.ollamaModel}`,
      modelos: r.modelos,
    };
  }

  private async probarAnthropic(apiKey: string): Promise<ResultadoPrueba> {
    if (apiKey === '') return { ok: false, mensaje: 'Falta la API Key de Anthropic' };
    try {
      const r = await this.fetchFn('https://api.anthropic.com/v1/models?limit=1', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) return { ok: true, mensaje: 'API Key válida: conexión correcta con Anthropic.' };
      if (r.status === 401 || r.status === 403) {
        return { ok: false, mensaje: 'Anthropic rechazó la API Key (no autorizada).' };
      }
      return { ok: false, mensaje: `Anthropic respondió con estado ${r.status}` };
    } catch {
      return { ok: false, mensaje: 'No se pudo conectar con la API de Anthropic' };
    }
  }
}

// ============================== Puerto LLM dinámico ==============================
export class LlmDinamico implements LlmPuerto {
  private firma = '';
  private adaptador: LlmPuerto | null = null;

  constructor(
    private readonly servicio: ServicioConfigLlm,
    private readonly guardrail: GuardrailPromptInjection,
  ) {}

  async decidir(ctx: ContextoRazonamiento): Promise<DecisionAgente> {
    const { config, apiKey } = await this.servicio.efectiva();
    return this.adaptadorPara(config, apiKey).decidir(ctx);
  }

  private adaptadorPara(config: ConfigLlm, apiKey: string): LlmPuerto {
    const firma = [
      config.proveedor,
      config.anthropicModel,
      config.ollamaBaseUrl,
      config.ollamaModel,
      createHash('sha256').update(apiKey).digest('hex').slice(0, 16),
    ].join('|');
    if (this.adaptador !== null && firma === this.firma) return this.adaptador;

    let nuevo: LlmPuerto;
    if (config.proveedor === 'anthropic') {
      if (apiKey === '') {
        throw new Error('El proveedor Anthropic está seleccionado pero no hay API Key configurada');
      }
      nuevo = new LlmAnthropic(apiKey, config.anthropicModel, this.guardrail);
    } else if (config.proveedor === 'ollama') {
      nuevo = new LlmOllama(config.ollamaBaseUrl, config.ollamaModel, this.guardrail);
    } else {
      nuevo = new LlmLocalDeterminista();
    }
    this.firma = firma;
    this.adaptador = nuevo;
    return nuevo;
  }
}
