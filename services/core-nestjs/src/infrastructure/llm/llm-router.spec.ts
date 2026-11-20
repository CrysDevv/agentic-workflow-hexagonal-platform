import { GuardrailPromptInjection } from '../../application/guardrails/prompt-injection.guardrail';
import { ErrorValidacion } from '../../domain/entities';
import type { ContextoRazonamiento } from '../../domain/ports';
import {
  LlmDinamico,
  ServicioConfigLlm,
  cifrar,
  descifrar,
  parsearCambio,
  validarUrlOllama,
  type AlmacenConfigLlm,
  type DefectoLlm,
} from './llm-router';
import { LlmOllama } from './ollama.adapter';

const SECRETO = 's'.repeat(40);
const CLAVE_IA = 'sk-ant-clave-de-prueba-0123456789abcdef';
const DEFECTO: DefectoLlm = {
  provider: 'local-deterministic',
  anthropicApiKey: '',
  anthropicModel: 'claude-sonnet-4-5',
  ollamaBaseUrl: 'http://ollama:11434',
  ollamaModel: 'llama3.2:3b',
};

class AlmacenMemoriaCfg implements AlmacenConfigLlm {
  valor: string | null = null;

  async leer(): Promise<string | null> {
    return this.valor;
  }

  async guardar(valor: string): Promise<void> {
    this.valor = valor;
  }
}

const respuesta = (cuerpo: unknown, ok = true, status = 200) => ({ ok, status, json: async () => cuerpo });
const comoFetch = (f: unknown): typeof fetch => f as unknown as typeof fetch;

function contexto(entrada: Record<string, never> = {}): ContextoRazonamiento {
  return {
    ejecucionId: 'e-1',
    flujo: { nombre: 'cotizacion-comercial', descripcion: 'Pruebas' },
    entrada,
    herramientas: [
      { nombre: 'consultar_catalogo', descripcion: 'Busca artículos' },
      { nombre: 'notificar', descripcion: 'Envía correo' },
    ],
    historial: [],
    pasoActual: 1,
    maxPasos: 8,
  };
}

describe('cifrado de la API Key', () => {
  it('descifra con el mismo secreto y falla con otro', () => {
    const c = cifrar(CLAVE_IA, SECRETO);
    expect(c).not.toContain(CLAVE_IA);
    expect(descifrar(c, SECRETO)).toBe(CLAVE_IA);
    expect(descifrar(c, 'x'.repeat(40))).toBeNull();
    expect(descifrar('basura', SECRETO)).toBeNull();
  });
});

describe('validación de entradas', () => {
  it('normaliza URLs válidas y rechaza las peligrosas', () => {
    expect(validarUrlOllama('http://ollama:11434/')).toBe('http://ollama:11434');
    expect(validarUrlOllama('http://host.docker.internal:11434')).toBe('http://host.docker.internal:11434');
    for (const mala of ['ftp://x', 'http://u:p@x', 'http://169.254.169.254', 'no es url', 'http://x?a=1']) {
      expect(() => validarUrlOllama(mala)).toThrow(ErrorValidacion);
    }
  });

  it('parsearCambio valida proveedor, modelo y clave', () => {
    expect(parsearCambio({ proveedor: 'ollama', ollamaModel: 'llama3.2:3b' })).toEqual({
      proveedor: 'ollama',
      ollamaModel: 'llama3.2:3b',
    });
    expect(() => parsearCambio({ proveedor: 'otro' })).toThrow(ErrorValidacion);
    expect(() => parsearCambio({ anthropicApiKey: 'corta' })).toThrow(ErrorValidacion);
    expect(() => parsearCambio({ ollamaModel: 'mal modelo;' })).toThrow(ErrorValidacion);
    expect(() => parsearCambio('texto')).toThrow(ErrorValidacion);
  });
});

describe('ServicioConfigLlm', () => {
  const crear = (almacen = new AlmacenMemoriaCfg(), defecto: DefectoLlm = DEFECTO, f?: typeof fetch) =>
    new ServicioConfigLlm(defecto, almacen, SECRETO, 0, f);

  it('arranca sin API Key con el proveedor determinista local', async () => {
    expect(await crear().vista()).toMatchObject({
      proveedor: 'local-deterministic',
      anthropicKeyConfigurada: false,
      origenClave: 'ninguna',
    });
  });

  it('rechaza Anthropic sin API Key y acepta Ollama sin clave', async () => {
    const s = crear();
    await expect(s.actualizar({ proveedor: 'anthropic' })).rejects.toBeInstanceOf(ErrorValidacion);
    await expect(s.actualizar({})).rejects.toBeInstanceOf(ErrorValidacion);
    expect(await s.actualizar({ proveedor: 'ollama', ollamaModel: 'qwen2.5:3b' })).toMatchObject({
      proveedor: 'ollama',
      ollamaModel: 'qwen2.5:3b',
    });
  });

  it('guarda la clave cifrada y nunca la expone', async () => {
    const almacen = new AlmacenMemoriaCfg();
    const vista = await crear(almacen).actualizar({ proveedor: 'anthropic', anthropicApiKey: CLAVE_IA });
    expect(vista).toMatchObject({ proveedor: 'anthropic', anthropicKeyConfigurada: true, origenClave: 'interfaz' });
    expect(JSON.stringify(vista)).not.toContain(CLAVE_IA);
    expect(almacen.valor).not.toContain(CLAVE_IA);
  });

  it('comparte la configuración entre réplicas y permite borrar la clave', async () => {
    const almacen = new AlmacenMemoriaCfg();
    const a = crear(almacen);
    const b = crear(almacen);
    await a.actualizar({ proveedor: 'anthropic', anthropicApiKey: CLAVE_IA });
    expect((await b.efectiva()).apiKey).toBe(CLAVE_IA);

    await expect(a.actualizar({ proveedor: 'anthropic', borrarAnthropicKey: true })).rejects.toBeInstanceOf(
      ErrorValidacion,
    );
    const vista = await a.actualizar({ proveedor: 'local-deterministic', borrarAnthropicKey: true });
    expect(vista.anthropicKeyConfigurada).toBe(false);
    expect((await b.vista()).proveedor).toBe('local-deterministic');
  });

  it('usa la clave del entorno como respaldo', async () => {
    const s = crear(new AlmacenMemoriaCfg(), { ...DEFECTO, anthropicApiKey: CLAVE_IA });
    expect(await s.vista()).toMatchObject({ anthropicKeyConfigurada: true, origenClave: 'entorno' });
    expect((await s.actualizar({ proveedor: 'anthropic' })).proveedor).toBe('anthropic');
  });

  it('prueba y lista modelos de Ollama', async () => {
    const f = jest.fn(async (_url: string) => respuesta({ models: [{ name: 'llama3.2:3b' }, { name: 'qwen2.5:3b' }] }));
    const s = crear(new AlmacenMemoriaCfg(), DEFECTO, comoFetch(f));

    expect(await s.probar({ proveedor: 'ollama' })).toMatchObject({ ok: true });
    expect(f.mock.calls[0]?.[0]).toBe('http://ollama:11434/api/tags');
    const ausente = await s.probar({ proveedor: 'ollama', ollamaModel: 'mistral' });
    expect(ausente.ok).toBe(false);
    expect(ausente.mensaje).toContain('ollama pull mistral');
    expect((await s.modelosOllama('http://otro:11434')).modelos).toEqual(['llama3.2:3b', 'qwen2.5:3b']);
    expect(f.mock.calls[f.mock.calls.length - 1]?.[0]).toBe('http://otro:11434/api/tags');
  });

  it('informa de forma controlada cuando Ollama no responde', async () => {
    const f = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const r = await crear(new AlmacenMemoriaCfg(), DEFECTO, comoFetch(f)).probar({ proveedor: 'ollama' });
    expect(r).toEqual({ ok: false, mensaje: 'No se pudo conectar con Ollama en http://ollama:11434' });
  });

  it('prueba la API Key de Anthropic', async () => {
    const ok = crear(new AlmacenMemoriaCfg(), DEFECTO, comoFetch(jest.fn(async () => respuesta({}))));
    expect((await ok.probar({ proveedor: 'anthropic', anthropicApiKey: CLAVE_IA })).ok).toBe(true);
    const rechazada = crear(new AlmacenMemoriaCfg(), DEFECTO, comoFetch(jest.fn(async () => respuesta({}, false, 401))));
    expect((await rechazada.probar({ proveedor: 'anthropic', anthropicApiKey: CLAVE_IA })).ok).toBe(false);
    expect((await crear().probar({ proveedor: 'anthropic' })).mensaje).toContain('Falta la API Key');
  });
});

describe('LlmDinamico', () => {
  const guardrail = new GuardrailPromptInjection();

  it('delega en el proveedor vigente y reacciona a los cambios de configuración', async () => {
    const servicio = new ServicioConfigLlm(DEFECTO, new AlmacenMemoriaCfg(), SECRETO, 0);
    const llm = new LlmDinamico(servicio, guardrail);

    expect(await llm.decidir(contexto())).toMatchObject({ tipo: 'FINAL', resultado: { estado: 'ENTRADA_INVALIDA' } });

    await servicio.actualizar({ proveedor: 'ollama', ollamaBaseUrl: 'http://127.0.0.1:1' });
    await expect(llm.decidir(contexto())).rejects.toThrow();

    await servicio.actualizar({ proveedor: 'local-deterministic' });
    expect(await llm.decidir(contexto())).toMatchObject({ tipo: 'FINAL' });
  });
});

describe('LlmOllama', () => {
  const guardrail = new GuardrailPromptInjection();
  type Init = { body: string; headers: Record<string, string> };

  it('envía el chat con JSON forzado, temperatura 0 y datos no confiables', async () => {
    const f = jest.fn(async (_url: string, _init: Init) =>
      respuesta({
        message: {
          content:
            'Respuesta: {"tipo":"HERRAMIENTA","herramienta":"consultar_catalogo","entrada":{"limite":5},"razonamiento":"Consulto"}',
        },
      }),
    );
    const llm = new LlmOllama('http://ollama:11434', 'llama3.2:3b', guardrail, comoFetch(f));

    expect(await llm.decidir(contexto())).toEqual({
      tipo: 'HERRAMIENTA',
      herramienta: 'consultar_catalogo',
      entrada: { limite: 5 },
      razonamiento: 'Consulto',
    });
    const [url, init] = f.mock.calls[0] as [string, Init];
    expect(url).toBe('http://ollama:11434/api/chat');
    const cuerpo = JSON.parse(init.body) as {
      model: string;
      format: string;
      stream: boolean;
      options: { temperature: number };
      messages: Array<{ role: string; content: string }>;
    };
    expect(cuerpo).toMatchObject({ model: 'llama3.2:3b', format: 'json', stream: false, options: { temperature: 0 } });
    expect(cuerpo.messages[0]?.content).toContain('consultar_catalogo');
    expect(cuerpo.messages[1]?.content.startsWith('<datos_no_confiables')).toBe(true);
  });

  it('falla ante estados HTTP no exitosos y respuestas fuera de contrato', async () => {
    const error = new LlmOllama('http://ollama:11434', 'm', guardrail, comoFetch(jest.fn(async () => respuesta({}, false, 500))));
    await expect(error.decidir(contexto())).rejects.toThrow('500');
    for (const cuerpo of [{}, { message: { content: 'sin json' } }, { message: { content: '{"tipo":"OTRO"}' } }]) {
      const llm = new LlmOllama('http://ollama:11434', 'm', guardrail, comoFetch(jest.fn(async () => respuesta(cuerpo))));
      await expect(llm.decidir(contexto())).rejects.toThrow();
    }
  });
});
