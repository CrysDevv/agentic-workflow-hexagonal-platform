import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, esRegistro, solicitudCruda, type Problema } from './api';
import { AlertaBanner, CabeceraSeccion, IconoCheck, IconoCpu, IconoPlay } from './ui';

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

const OPCIONES: ReadonlyArray<{ id: Proveedor; titulo: string; etiqueta: string; detalle: string }> = [
  {
    id: 'local-deterministic',
    titulo: 'Motor Determinista Local',
    etiqueta: 'COSTO $0 · SIN API KEY',
    detalle: 'Ejecución de reglas verificables en memoria. Ideal para demos reproducibles y CI/CD.',
  },
  {
    id: 'ollama',
    titulo: 'Ollama (Local / On-Premise)',
    etiqueta: 'PRIVADO · MODELOS OPEN-WEIGHT',
    detalle: 'Inferencia soberana en tu propio servidor o contenedor Docker sin salida a internet.',
  },
  {
    id: 'anthropic',
    titulo: 'Anthropic Claude API',
    etiqueta: 'CLOUD · TOOL-USE NATIVO',
    detalle: 'Razonamiento avanzado con esquema estructurado garantizado. Requiere API Key cifrada.',
  },
];

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
      setAviso(`Proveedor "${vista.proveedor}" activado en caliente para todas las réplicas.`);
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
    <section className="space-y-5">
      <CabeceraSeccion
        titulo="Enrutador Dinámico de Modelos de IA"
        subtitulo="Cambia el motor de razonamiento en caliente sin reiniciar contenedores. La configuración se sincroniza vía Redis."
        accion={
          consulta.data !== undefined ? (
            <span className="inline-flex items-center gap-2 rounded-full border border-sky-500/30 bg-sky-950/70 px-3 py-1 font-mono text-xs text-sky-300">
              <IconoCpu className="h-3.5 w-3.5" />
              Activo: {consulta.data.proveedor}
            </span>
          ) : undefined
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        {OPCIONES.map((o) => {
          const seleccionado = proveedor === o.id;
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => setProveedor(o.id)}
              aria-pressed={seleccionado}
              className={`rounded-xl border p-4 text-left transition duration-150 ${
                seleccionado
                  ? 'border-sky-500/80 bg-sky-950/25 shadow-lg shadow-sky-950/40'
                  : 'panel-glass hover:border-slate-700'
              }`}
            >
              <span className="inline-block rounded border border-slate-700/80 bg-slate-900/90 px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-sky-300">
                {o.etiqueta}
              </span>
              <p className="mt-2.5 text-base font-semibold text-white">{o.titulo}</p>
              <p className="mt-1 text-xs leading-relaxed text-slate-400">{o.detalle}</p>
            </button>
          );
        })}
      </div>

      {proveedor === 'ollama' && (
        <div className="panel-glass rounded-xl p-5 space-y-3">
          <h3 className="text-sm font-semibold text-white">Parámetros del servidor Ollama</h3>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block text-xs text-slate-400">
              Endpoint HTTP
              <input value={ollamaUrl} onChange={(e) => setOllamaUrl(e.target.value)} className="input-pro mt-1 w-full" />
            </label>
            <label className="block text-xs text-slate-400">
              Modelo local
              <input
                value={ollamaModel}
                onChange={(e) => setOllamaModel(e.target.value)}
                list="modelos-ollama"
                className="input-pro mt-1 w-full"
              />
              <datalist id="modelos-ollama">
                {modelos.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>
          </div>
          <button type="button" disabled={ocupado} className="btn-secondary" onClick={() => detectar.mutate()}>
            Detectar modelos instalados
          </button>
        </div>
      )}

      {proveedor === 'anthropic' && (
        <div className="panel-glass rounded-xl p-5 space-y-3">
          <h3 className="text-sm font-semibold text-white">Credenciales de Anthropic Claude</h3>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block text-xs text-slate-400">
              Identificador del modelo
              <input value={anthropicModel} onChange={(e) => setAnthropicModel(e.target.value)} className="input-pro mt-1 w-full" />
            </label>
            <label className="block text-xs text-slate-400">
              API Key (cifrada con AES-256-GCM)
              <input
                type="password"
                autoComplete="off"
                value={claveIa}
                onChange={(e) => setClaveIa(e.target.value)}
                placeholder={
                  consulta.data?.anthropicKeyConfigurada === true
                    ? `Configurada (${consulta.data.origenClave}). Escribe para rotar`
                    : 'sk-ant-...'
                }
                className="input-pro mt-1 w-full"
              />
            </label>
          </div>
          {consulta.data?.origenClave === 'interfaz' && (
            <label className="flex items-center gap-2 text-xs text-slate-400">
              <input type="checkbox" checked={borrarClave} onChange={(e) => setBorrarClave(e.target.checked)} />
              Revocar y eliminar la API Key guardada en Redis
            </label>
          )}
        </div>
      )}

      {error !== null && <AlertaBanner mensaje={mensajeError(error)} tipo="error" />}
      {resultado !== null && <AlertaBanner mensaje={resultado.mensaje} tipo={resultado.ok ? 'exito' : 'aviso'} />}
      {aviso !== null && <AlertaBanner mensaje={aviso} tipo="exito" />}

      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={ocupado} className="btn-secondary" onClick={() => probar.mutate()}>
          <IconoPlay />
          Verificar conectividad
        </button>
        <button type="button" disabled={ocupado} className="btn-primary" onClick={() => guardar.mutate()}>
          <IconoCheck />
          Guardar y activar
        </button>
      </div>
    </section>
  );
}
