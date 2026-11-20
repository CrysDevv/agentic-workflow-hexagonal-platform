import { useState, type ReactNode } from 'react';

// ============================== Iconografía SVG Vectorial (cero dependencias) ==============================
type IconProps = { className?: string };

export function IconoEscudo({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l7 3v5c0 4.97-3.05 9.12-7 10.5C8.05 20.12 5 15.97 5 11V6l7-3z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" />
    </svg>
  );
}

export function IconoActividad({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h4l3-7 4 14 3-7h4" />
    </svg>
  );
}

export function IconoCpu({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
      <path strokeLinecap="round" d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
    </svg>
  );
}

export function IconoChispas({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 16l.9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9L19 16z" />
    </svg>
  );
}

export function IconoLlave({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <circle cx="8" cy="15" r="4" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M11 12l9-9M17 6l3 3M14 9l2.5 2.5" />
    </svg>
  );
}

export function IconoCheck({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

export function IconoCerrar({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function IconoCopiar({ className = 'h-3.5 w-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

export function IconoPlay({ className = 'h-4 w-4' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <polygon points="6 4 20 12 6 20 6 4" strokeLinejoin="round" />
    </svg>
  );
}

export function IconoReloj({ className = 'h-3.5 w-3.5' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 7v5l3 2" />
    </svg>
  );
}

// ============================== Componentes de Diseño ==============================
const ESTILO_ESTADO: Record<string, { badge: string; punto: string; pulso?: boolean }> = {
  PENDIENTE: {
    badge: 'border-slate-600/50 bg-slate-800/80 text-slate-200',
    punto: 'bg-slate-400',
  },
  EN_EJECUCION: {
    badge: 'border-sky-500/40 bg-sky-950/80 text-sky-200',
    punto: 'bg-sky-400',
    pulso: true,
  },
  PAUSADA_APROBACION: {
    badge: 'border-amber-500/40 bg-amber-950/80 text-amber-200',
    punto: 'bg-amber-400',
    pulso: true,
  },
  COMPLETADA: {
    badge: 'border-emerald-500/40 bg-emerald-950/80 text-emerald-200',
    punto: 'bg-emerald-400',
  },
  COMPLETADO: {
    badge: 'border-emerald-500/40 bg-emerald-950/80 text-emerald-200',
    punto: 'bg-emerald-400',
  },
  APROBADA: {
    badge: 'border-emerald-500/40 bg-emerald-950/80 text-emerald-200',
    punto: 'bg-emerald-400',
  },
  RECHAZADA: {
    badge: 'border-rose-500/40 bg-rose-950/80 text-rose-200',
    punto: 'bg-rose-400',
  },
  BLOQUEADO: {
    badge: 'border-rose-500/40 bg-rose-950/80 text-rose-200',
    punto: 'bg-rose-400',
  },
  FALLIDA: {
    badge: 'border-red-500/40 bg-red-950/80 text-red-200',
    punto: 'bg-red-400',
  },
  FALLIDO: {
    badge: 'border-red-500/40 bg-red-950/80 text-red-200',
    punto: 'bg-red-400',
  },
  EXPIRADA: {
    badge: 'border-slate-600/40 bg-slate-800/60 text-slate-300',
    punto: 'bg-slate-400',
  },
};

export function InsigniaEstado({ estado }: { estado: string }) {
  const cfg = ESTILO_ESTADO[estado] ?? {
    badge: 'border-slate-600/50 bg-slate-800/80 text-slate-200',
    punto: 'bg-slate-400',
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold tracking-wide ${cfg.badge}`}
    >
      <span className="relative flex h-2 w-2">
        {cfg.pulso && (
          <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${cfg.punto}`} />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${cfg.punto}`} />
      </span>
      {estado}
    </span>
  );
}

export function TarjetaKpi({
  etiqueta,
  valor,
  subtitulo,
  acento = 'sky',
  icono,
}: {
  etiqueta: string;
  valor: string | number;
  subtitulo?: string;
  acento?: 'sky' | 'amber' | 'emerald' | 'rose';
  icono: ReactNode;
}) {
  const colores: Record<string, string> = {
    sky: 'border-sky-500/20 text-sky-400 bg-sky-500/10',
    amber: 'border-amber-500/20 text-amber-400 bg-amber-500/10',
    emerald: 'border-emerald-500/20 text-emerald-400 bg-emerald-500/10',
    rose: 'border-rose-500/20 text-rose-400 bg-rose-500/10',
  };
  return (
    <div className="panel-glass rounded-xl p-4 transition duration-150 hover:border-slate-600/70">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">{etiqueta}</p>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-100 tabular-nums">{valor}</p>
          {subtitulo !== undefined && <p className="mt-1 text-xs leading-relaxed text-slate-400">{subtitulo}</p>}
        </div>
        <div className={`rounded-lg border p-2 ${colores[acento]}`}>{icono}</div>
      </div>
    </div>
  );
}

export function VisorJson({ valor, titulo }: { valor: unknown; titulo?: string }) {
  const [copiado, setCopiado] = useState(false);
  const texto = JSON.stringify(valor, null, 2);

  function copiar(): void {
    void navigator.clipboard?.writeText(texto).then(() => {
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1800);
    });
  }

  return (
    <div className="overflow-hidden rounded-lg border border-slate-800/90 bg-slate-950/95">
      <div className="flex items-center justify-between border-b border-slate-800/80 bg-slate-900/70 px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wider text-slate-400">{titulo ?? 'JSON'}</span>
        <button
          type="button"
          onClick={copiar}
          className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-slate-400 transition hover:bg-slate-800 hover:text-slate-200"
        >
          {copiado ? <IconoCheck className="h-3 w-3 text-emerald-400" /> : <IconoCopiar />}
          {copiado ? 'Copiado' : 'Copiar'}
        </button>
      </div>
      <pre className="max-h-72 overflow-auto p-3 font-mono text-xs leading-relaxed text-slate-200">{texto}</pre>
    </div>
  );
}

export function AlertaBanner({
  mensaje,
  tipo = 'error',
}: {
  mensaje: string;
  tipo?: 'error' | 'exito' | 'aviso';
}) {
  const estilos: Record<string, string> = {
    error: 'border-rose-500/40 bg-rose-950/70 text-rose-200',
    exito: 'border-emerald-500/40 bg-emerald-950/70 text-emerald-200',
    aviso: 'border-amber-500/40 bg-amber-950/70 text-amber-200',
  };
  return (
    <div
      role={tipo === 'error' ? 'alert' : 'status'}
      className={`rounded-lg border px-3.5 py-2.5 text-sm leading-relaxed ${estilos[tipo]}`}
    >
      {mensaje}
    </div>
  );
}

export function CabeceraSeccion({
  titulo,
  subtitulo,
  accion,
}: {
  titulo: string;
  subtitulo?: string;
  accion?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3 border-b border-slate-800/70 pb-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-slate-100">{titulo}</h2>
        {subtitulo !== undefined && <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-slate-400">{subtitulo}</p>}
      </div>
      {accion !== undefined && <div>{accion}</div>}
    </div>
  );
}

export function EsqueletoTarjetas({ cantidad = 2 }: { cantidad?: number }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {Array.from({ length: cantidad }).map((_, i) => (
        <div key={i} className="panel-glass animate-pulse rounded-xl p-5 space-y-3">
          <div className="h-4 w-1/3 rounded bg-slate-800" />
          <div className="h-6 w-2/3 rounded bg-slate-800/80" />
          <div className="h-16 w-full rounded bg-slate-900" />
        </div>
      ))}
    </div>
  );
}

export function EstadoVacio({
  icono,
  titulo,
  descripcion,
}: {
  icono: ReactNode;
  titulo: string;
  descripcion: string;
}) {
  return (
    <div className="panel-glass flex flex-col items-center justify-center rounded-xl px-6 py-12 text-center">
      <div className="mb-3 rounded-full border border-slate-700/80 bg-slate-900/90 p-3 text-slate-400">{icono}</div>
      <h3 className="text-base font-medium text-slate-200">{titulo}</h3>
      <p className="mt-1 max-w-md text-sm text-slate-400">{descripcion}</p>
    </div>
  );
}
