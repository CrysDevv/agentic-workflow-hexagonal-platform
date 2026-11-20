import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, esRegistro, type EstadoEjecucion, type Paso } from './api';

type Objeto = Record<string, unknown>;

const TERMINALES: readonly EstadoEjecucion[] = ['COMPLETADA', 'RECHAZADA', 'FALLIDA'];

const PROMPTS_RAPIDOS: ReadonlyArray<{ etiqueta: string; flujo: string; entrada: Objeto }> = [
  {
    etiqueta: 'Auditar estado, S3 y seguridad del sistema',
    flujo: 'asistente-operativo',
    entrada: {
      consulta: 'Inspecciona los flujos activos, propuestas emitidas en S3, ejecuciones recientes y eventos de seguridad.',
    },
  },
  {
    etiqueta: 'Consultar historial y propuestas de Acme SA',
    flujo: 'asistente-operativo',
    entrada: {
      consulta: 'Resume todas las ejecuciones y propuestas comerciales emitidas para Acme SA.',
      cliente: 'Acme SA',
    },
  },
  {
    etiqueta: 'Cotizar 3 laptops y 5 licencias (con validación HITL)',
    flujo: 'cotizacion-comercial',
    entrada: {
      cliente: 'Innovación Austral SpA',
      items: [
        { sku: 'HW-LAP-001', cantidad: 3 },
        { sku: 'SW-LIC-010', cantidad: 5 },
      ],
      notificarA: 'compras@austral.cl',
    },
  },
];

function mensajeError(error: unknown): string {
  if (error instanceof ApiError) {
    const detalle = error.problema.detail ?? error.message;
    return `${error.status} ${error.problema.title ?? 'Error'}: ${detalle}`;
  }
  return error instanceof Error ? error.message : 'Error desconocido';
}

export default function CopilotoIa({
  apiKey,
  alVerTraza,
}: {
  apiKey: string;
  alVerTraza: (ejecucionId: string) => void;
}) {
  const qc = useQueryClient();
  const [flujo, setFlujo] = useState('asistente-operativo');
  const [pregunta, setPregunta] = useState(
    'Inspecciona los flujos activos, propuestas emitidas en S3, ejecuciones recientes y eventos de seguridad.',
  );
  const [clienteFiltro, setClienteFiltro] = useState('');
  const [ejecucionActivaId, setEjecucionActivaId] = useState<string | null>(null);

  const lanzar = useMutation({
    mutationFn: (payload: { flujo: string; entrada: Objeto }) => api.iniciar(apiKey, payload.flujo, payload.entrada),
    onSuccess: (ej) => {
      setEjecucionActivaId(ej.id);
      void qc.invalidateQueries({ queryKey: ['ejecuciones'] });
    },
  });

  const traza = useQuery({
    queryKey: ['traza', apiKey, ejecucionActivaId],
    queryFn: () => api.traza(apiKey, ejecucionActivaId as string),
    enabled: ejecucionActivaId !== null,
    refetchInterval: (q) => {
      const datos = q.state.data;
      return datos !== undefined && TERMINALES.includes(datos.ejecucion.estado) ? false : 2000;
    },
  });

  useEffect(() => {
    if (traza.data !== undefined && TERMINALES.includes(traza.data.ejecucion.estado)) {
      void qc.invalidateQueries({ queryKey: ['ejecuciones'] });
      void qc.invalidateQueries({ queryKey: ['aprobaciones'] });
    }
  }, [traza.data, qc]);

  function enviarConsulta(): void {
    const limpio = pregunta.trim();
    if (limpio === '') return;
    const entrada: Objeto = { consulta: limpio };
    if (clienteFiltro.trim() !== '') entrada['cliente'] = clienteFiltro.trim();
    lanzar.mutate({ flujo, entrada });
  }

  const pasos: Paso[] = traza.data?.pasos ?? [];
  const resultado = traza.data?.ejecucion.resultado ?? null;
  const resumenOp =
    esRegistro(resultado) && esRegistro(resultado['resumenOperativo']) ? resultado['resumenOperativo'] : null;

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white">Copiloto IA de Lectura y Operación</h2>
        <p className="text-sm text-slate-400">
          Interactúa directamente con el agente. Ahora puede leer PostgreSQL (flujos, ejecuciones, catálogo, auditoría)
          y Object Storage S3 (propuestas emitidas) bajo los mismos guardrails OWASP LLM01 y controles HITL.
        </p>
      </div>

      <div className="panel-elevated rounded-xl p-5 space-y-3">
        <div className="flex flex-wrap gap-2">
          {PROMPTS_RAPIDOS.map((p) => (
            <button
              key={p.etiqueta}
              type="button"
              onClick={() => {
                setFlujo(p.flujo);
                if (typeof p.entrada['consulta'] === 'string') {
                  setPregunta(p.entrada['consulta']);
                  setClienteFiltro(typeof p.entrada['cliente'] === 'string' ? p.entrada['cliente'] : '');
                }
                lanzar.mutate({ flujo: p.flujo, entrada: p.entrada });
              }}
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-300 transition hover:border-sky-500 hover:text-white"
            >
              {p.etiqueta}
            </button>
          ))}
        </div>

        <div className="grid gap-3 md:grid-cols-[14rem_1fr]">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Flujo destino</label>
            <select
              value={flujo}
              onChange={(e) => setFlujo(e.target.value)}
              className="w-full input-pro w-full"
            >
              <option value="asistente-operativo">asistente-operativo (lectura)</option>
              <option value="cotizacion-comercial">cotizacion-comercial</option>
              <option value="compra-administrativa">compra-administrativa</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Filtro de cliente (opcional)</label>
            <input
              value={clienteFiltro}
              onChange={(e) => setClienteFiltro(e.target.value)}
              placeholder="Ej. Acme SA"
              className="w-full input-pro w-full"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1">Instrucción o consulta para el agente</label>
          <textarea
            value={pregunta}
            onChange={(e) => setPregunta(e.target.value)}
            rows={3}
            placeholder="Describe qué deseas que la IA inspeccione o ejecute..."
            className="w-full input-pro w-full"
          />
        </div>

        {lanzar.isError && (
          <div role="alert" className="rounded-lg border border-rose-800 bg-rose-950 px-3 py-2 text-sm text-rose-200">
            {mensajeError(lanzar.error)}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={lanzar.isPending}
            onClick={enviarConsulta}
            className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-500 disabled:opacity-50"
          >
            {lanzar.isPending ? 'Enviando al agente…' : 'Consultar al agente'}
          </button>
          {ejecucionActivaId !== null && (
            <button
              type="button"
              onClick={() => alVerTraza(ejecucionActivaId)}
              className="rounded-lg bg-slate-800 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700"
            >
              Abrir en Trazador completo
            </button>
          )}
        </div>
      </div>

      {traza.data !== undefined && (
        <div className="panel-elevated rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="text-xs uppercase tracking-wider text-slate-400">Ejecución </span>
              <span className="font-mono text-xs text-sky-300">{traza.data.ejecucion.id}</span>
            </div>
            <span className="rounded-full bg-slate-800 px-3 py-0.5 text-xs font-semibold text-white">
              {traza.data.ejecucion.estado}
            </span>
          </div>

          {resumenOp !== null && (
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {Object.entries(resumenOp).map(([k, v]) => (
                <div key={k} className="rounded-lg border border-slate-800 bg-slate-950 p-3">
                  <p className="text-[11px] text-slate-400 truncate">{k}</p>
                  <p className="mt-1 text-lg font-bold text-white">{String(v)}</p>
                </div>
              ))}
            </div>
          )}

          {pasos.length > 0 && (
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                Herramientas invocadas ({pasos.length})
              </h3>
              <div className="space-y-2">
                {pasos.map((p) => (
                  <div key={p.id} className="rounded-lg border border-slate-800 bg-slate-950 p-2.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-semibold text-sky-300">
                        #{p.orden} {p.herramienta}
                      </span>
                      <span className="text-slate-400">
                        {p.estado} {p.duracionMs !== null ? `· ${p.duracionMs} ms` : ''}
                      </span>
                    </div>
                    {p.razonamiento !== null && <p className="mt-1 text-slate-400 italic">{p.razonamiento}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {resultado !== null && (
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                Respuesta estructurada del agente
              </h3>
              <pre className="max-h-96 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs text-slate-200">
                {JSON.stringify(resultado, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
