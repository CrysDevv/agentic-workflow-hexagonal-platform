import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, esRegistro, solicitudCruda, type Problema } from './api';

type Proveedor = 'local-deterministic' | 'ollama' | 'anthropic';

interface Vista {
  proveedor: Proveedor;
  anthropicModel: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  anthropicKeyConfigurada: boolean;
  origenClave: 'interfaz' | 'entorno' | 'ninguna';
}

interface Prueba {
  ok: boolean;
  mensaje: string;
  modelos?: string[];
}

const OPCIONES: ReadonlyArray<{ id: Proveedor; titulo: string; detalle: string }> = [
  {
    id: 'local-deterministic',
    titulo: 'Determinista local',
    detalle: 'Sin IA ni API Key. Costo $0. Ideal para demostraciones y pruebas.',
  },
  {
    id: 'ollama',
    titulo: 'Ollama (modelos locales)',
    detalle: 'Un LLM que corre en tu máquina. Sin API Key ni costo por uso.',
  },
  {
    id: 'anthropic',
    titulo: 'API de Anthropic (Claude)',
    detalle: 'Modelos en la nube. Requiere una API Key y se paga por uso.',
  },
];

const BOTON =
  'rounded px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50';
const CAMPO = 'w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm';

async function llamar<T>(ruta: string, apiKey: string, metodo: 'GET' | 'POST' = 'GET', cuerpo?: unknown): Promise<T> {
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

function mensajeError(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.status} ${error.problema.title ?? 'Error'}: ${error.problema.detail ?? error.message}`;
  }
  return error instanceof Error ? error.message : 'Error desconocido';
}

export default function ConfigLlm({ apiKey }: { apiKey: string }) {
  const qc = useQueryClient();
  const consulta = useQuery({
    queryKey: ['config-llm', apiKey],
    queryFn: () => llamar<Vista>('/configuracion/llm', apiKey),
  });

  const [proveedor, setProveedor] = useState<Proveedor>('local-deterministic');
  const [anthropicModel, setAnthropicModel] = useState('claude-sonnet-4-5');
  const [claveIa, setClaveIa] = useState('');
  const [borrarClave, setBorrarClave] = useState(false);
  const [ollamaUrl, setOllamaUrl] = useState('http://ollama:11434');
  const [ollamaModel, setOllamaModel] = useState('llama3.2:3b');
  const [modelos, setModelos] = useState<string[]>([]);
  const [resultado, setResultado] = useState<Prueba | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => {
    const d = consulta.data;
    if (d === undefined) return;
    setProveedor(d.proveedor);
    setAnthropicModel(d.anthropicModel);
    setOllamaUrl(d.ollamaBaseUrl);
    setOllamaModel(d.ollamaModel);
    setClaveIa('');
    setBorrarClave(false);
  }, [consulta.data]);

  function cuerpo(): Record<string, unknown> {
    return {
      proveedor,
      anthropicModel,
      ollamaBaseUrl: ollamaUrl,
      ollamaModel,
      ...(claveIa.trim() === '' ? {} : { anthropicApiKey: claveIa.trim() }),
      ...(borrarClave ? { borrarAnthropicKey: true } : {}),
    };
  }

  const guardar = useMutation({
    mutationFn: () => llamar<Vista>('/configuracion/llm', apiKey, 'POST', cuerpo()),
    onSuccess: (vista) => {
      setResultado(null);
      setAviso(`Configuración guardada: proveedor activo "${vista.proveedor}".`);
      void qc.invalidateQueries({ queryKey: ['config-llm'] });
    },
    onError: () => setAviso(null),
  });

  const probar = useMutation({
    mutationFn: () => llamar<Prueba>('/configuracion/llm/probar', apiKey, 'POST', cuerpo()),
    onSuccess: (r) => {
      setAviso(null);
      setResultado(r);
      if (r.modelos !== undefined) setModelos(r.modelos);
    },
  });

  const detectar = useMutation({
    mutationFn: () =>
      llamar<Prueba>(`/configuracion/llm/ollama/modelos?baseUrl=${encodeURIComponent(ollamaUrl)}`, apiKey),
    onSuccess: (r) => {
      setAviso(null);
      setResultado(r);
      setModelos(r.modelos ?? []);
    },
  });

  const error = guardar.error ?? probar.error ?? detectar.error ?? (consulta.isError ? consulta.error : null);
  const ocupado = guardar.isPending || probar.isPending || detectar.isPending;

  return (
    <section>
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-white">Modelo de IA</h2>
        <p className="text-sm text-slate-400">
          Elige cómo decide el agente. No necesitas ninguna API Key para empezar: el modo determinista y Ollama funcionan
          sin ella. La selección se aplica en caliente a todas las réplicas. Solo el rol ADMIN puede cambiarla.
        </p>
      </div>

      {consulta.data !== undefined && (
        <p className="mb-3 text-sm text-slate-300">
          Proveedor activo: <span className="font-mono text-sky-300">{consulta.data.proveedor}</span>
        </p>
      )}

      <div className="mb-4 grid gap-3 md:grid-cols-3">
        {OPCIONES.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => setProveedor(o.id)}
            aria-pressed={proveedor === o.id}
            className={`rounded-lg border p-3 text-left transition ${
              proveedor === o.id ? 'border-sky-500 bg-slate-900' : 'border-slate-800 bg-slate-900/40 hover:border-slate-600'
            }`}
          >
            <p className="font-semibold text-white">{o.titulo}</p>
            <p className="mt-1 text-xs text-slate-400">{o.detalle}</p>
          </button>
        ))}
      </div>

      {proveedor === 'ollama' && (
        <div className="mb-4 rounded-lg border border-slate-800 bg-slate-900 p-4">
          <h3 className="mb-2 text-sm font-semibold text-white">Ollama</h3>
          <label className="mb-2 block text-xs text-slate-400">
            URL del servidor
            <input value={ollamaUrl} onChange={(e) => setOllamaUrl(e.target.value)} className={`${CAMPO} mt-1`} />
          </label>
          <label className="mb-2 block text-xs text-slate-400">
            Modelo
            <input
              value={ollamaModel}
              onChange={(e) => setOllamaModel(e.target.value)}
              list="modelos-ollama"
              className={`${CAMPO} mt-1`}
            />
            <datalist id="modelos-ollama">
              {modelos.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          <button
            type="button"
            disabled={ocupado}
            className={`${BOTON} bg-slate-800 hover:bg-slate-700`}
            onClick={() => detectar.mutate()}
          >
            Detectar modelos
          </button>
          <div className="mt-3 rounded bg-slate-950 p-2 text-xs text-slate-400">
            <p>Con Docker (incluido en este proyecto):</p>
            <p className="font-mono text-slate-300">docker compose --profile ollama up -d</p>
            <p className="font-mono text-slate-300">docker compose exec ollama ollama pull llama3.2:3b</p>
            <p className="mt-1">
              Si Ollama corre directamente en tu PC, usa <span className="font-mono">http://host.docker.internal:11434</span>.
              Los modelos pequeños pueden equivocarse al usar herramientas; el motor valida cada decisión.
            </p>
          </div>
        </div>
      )}

      {proveedor === 'anthropic' && (
        <div className="mb-4 rounded-lg border border-slate-800 bg-slate-900 p-4">
          <h3 className="mb-2 text-sm font-semibold text-white">API de Anthropic</h3>
          <label className="mb-2 block text-xs text-slate-400">
            Modelo
            <input value={anthropicModel} onChange={(e) => setAnthropicModel(e.target.value)} className={`${CAMPO} mt-1`} />
          </label>
          <label className="mb-2 block text-xs text-slate-400">
            API Key de Anthropic
            <input
              type="password"
              autoComplete="off"
              value={claveIa}
              onChange={(e) => setClaveIa(e.target.value)}
              placeholder={
                consulta.data?.anthropicKeyConfigurada === true
                  ? `Configurada (origen: ${consulta.data.origenClave}). Escribe una nueva para reemplazarla`
                  : 'sk-ant-...'
              }
              className={`${CAMPO} mt-1`}
            />
          </label>
          {consulta.data?.origenClave === 'interfaz' && (
            <label className="flex items-center gap-2 text-xs text-slate-400">
              <input type="checkbox" checked={borrarClave} onChange={(e) => setBorrarClave(e.target.checked)} />
              Eliminar la clave guardada
            </label>
          )}
          <p className="mt-2 text-xs text-slate-500">
            La clave se guarda cifrada (AES-256-GCM) en el servidor y nunca se vuelve a mostrar. No es la API Key de esta
            consola.
          </p>
        </div>
      )}

      {error !== null && (
        <div role="alert" className="mb-3 rounded border border-rose-800 bg-rose-950 px-3 py-2 text-sm text-rose-200">
          {mensajeError(error)}
        </div>
      )}
      {resultado !== null && (
        <div
          role="status"
          className={`mb-3 rounded border px-3 py-2 text-sm ${
            resultado.ok
              ? 'border-emerald-800 bg-emerald-950 text-emerald-200'
              : 'border-amber-800 bg-amber-950 text-amber-200'
          }`}
        >
          {resultado.mensaje}
        </div>
      )}
      {aviso !== null && (
        <div role="status" className="mb-3 rounded border border-emerald-800 bg-emerald-950 px-3 py-2 text-sm text-emerald-200">
          {aviso}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={ocupado}
          className={`${BOTON} bg-slate-800 hover:bg-slate-700`}
          onClick={() => probar.mutate()}
        >
          Probar conexión
        </button>
        <button
          type="button"
          disabled={ocupado}
          className={`${BOTON} bg-sky-700 hover:bg-sky-600`}
          onClick={() => guardar.mutate()}
        >
          Guardar y activar
        </button>
      </div>
    </section>
  );
}
