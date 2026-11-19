import {
  AprobacionHumana,
  Dinero,
  EjecucionAgente,
  ErrorDominio,
  ErrorTransicionInvalida,
  ErrorValidacion,
  NOMBRES_HERRAMIENTA,
  PasoEjecucion,
  esNombreHerramienta,
} from './entities';

const AHORA = new Date('2026-01-15T12:00:00.000Z');

function nuevaEjecucion(): EjecucionAgente {
  return EjecucionAgente.crear({
    id: 'e-1',
    flujoId: 'f-1',
    origen: 'API',
    entrada: { cliente: 'Acme' },
    correlationId: 'corr-12345678',
    ahora: AHORA,
  });
}

describe('Dinero (value object)', () => {
  it('convierte USD a centavos sin errores de punto flotante', () => {
    expect(Dinero.deUsd(10.1).centavos).toBe(1010);
    expect(Dinero.deUsd(0.1).sumar(Dinero.deUsd(0.2)).usd).toBe(0.3);
  });

  it('multiplica por cantidades enteras y compara montos', () => {
    const total = Dinero.deUsd(1150).multiplicar(5);
    expect(total.usd).toBe(5750);
    expect(total.superaA(Dinero.deUsd(5000))).toBe(true);
    expect(Dinero.deUsd(5000).superaA(Dinero.deUsd(5000))).toBe(false);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000_001])('rechaza el monto inválido %p', (valor) => {
    expect(() => Dinero.deUsd(valor)).toThrow(ErrorValidacion);
  });

  it('rechaza cantidades no enteras o negativas', () => {
    expect(() => Dinero.deUsd(10).multiplicar(1.5)).toThrow(ErrorValidacion);
    expect(() => Dinero.deUsd(10).multiplicar(-1)).toThrow(ErrorValidacion);
  });

  it('cero es neutro en la suma', () => {
    expect(Dinero.cero().sumar(Dinero.deUsd(7)).usd).toBe(7);
  });
});

describe('EjecucionAgente (máquina de estados)', () => {
  it('recorre el ciclo feliz con pausa y reanudación', () => {
    const e = nuevaEjecucion();
    expect(e.estado).toBe('PENDIENTE');
    e.iniciar(AHORA);
    e.pausarPorAprobacion(AHORA);
    expect(e.estado).toBe('PAUSADA_APROBACION');
    e.reanudar(AHORA);
    e.completar({ ok: true }, AHORA);
    expect(e.estado).toBe('COMPLETADA');
    expect(e.snapshot().finalizadoEn).toEqual(AHORA);
    expect(e.snapshot().resultado).toEqual({ ok: true });
  });

  it('impide transiciones inválidas y desde estados terminales', () => {
    const e = nuevaEjecucion();
    expect(() => e.completar({}, AHORA)).toThrow(ErrorTransicionInvalida);
    e.iniciar(AHORA);
    e.completar({}, AHORA);
    expect(() => e.fallar('x', AHORA)).toThrow(ErrorTransicionInvalida);
    expect(() => e.iniciar(AHORA)).toThrow(ErrorTransicionInvalida);
  });

  it('valida el correlationId y trunca los motivos largos', () => {
    expect(() =>
      EjecucionAgente.crear({ id: 'e', flujoId: 'f', origen: 'API', entrada: {}, correlationId: '   ', ahora: AHORA }),
    ).toThrow(ErrorValidacion);
    const e = nuevaEjecucion();
    e.iniciar(AHORA);
    e.rechazar('x'.repeat(5000), AHORA);
    expect(e.snapshot().error).toHaveLength(1000);
  });
});

describe('PasoEjecucion', () => {
  const crear = (orden = 1): PasoEjecucion =>
    PasoEjecucion.crear({
      id: 'p-1',
      ejecucionId: 'e-1',
      orden,
      herramienta: 'consultar_catalogo',
      razonamiento: null,
      entrada: {},
      ahora: AHORA,
    });

  it('rechaza órdenes inválidos', () => {
    expect(() => crear(0)).toThrow(ErrorValidacion);
    expect(() => crear(1.5)).toThrow(ErrorValidacion);
  });

  it('registra salida y duración al completarse', () => {
    const p = crear();
    p.iniciar();
    p.completar({ ok: 1 }, 12.6);
    expect(p.estado).toBe('COMPLETADO');
    expect(p.snapshot().duracionMs).toBe(13);
    expect(() => p.completar({}, 1)).toThrow(ErrorTransicionInvalida);
  });

  it('un paso pendiente puede bloquearse pero uno bloqueado no cambia', () => {
    const p = crear();
    p.bloquear('motivo');
    expect(p.estado).toBe('BLOQUEADO');
    expect(() => p.iniciar()).toThrow(ErrorTransicionInvalida);
  });
});

describe('AprobacionHumana', () => {
  const crear = (): AprobacionHumana =>
    AprobacionHumana.crear({
      id: 'a-1',
      ejecucionId: 'e-1',
      pasoId: 'p-1',
      accionPropuesta: { herramienta: 'emitir_propuesta_comercial' },
      motivo: 'Supera el umbral',
      montoUsd: 5750,
      ahora: AHORA,
    });

  it('nace PENDIENTE y se resuelve una sola vez', () => {
    const a = crear();
    expect(a.estado).toBe('PENDIENTE');
    a.aprobar('aprobador', 'ok', AHORA);
    expect(a.estado).toBe('APROBADA');
    expect(a.resueltoPor).toBe('aprobador');
    expect(() => a.rechazar('otro', null, AHORA)).toThrow(ErrorTransicionInvalida);
    expect(() => a.aprobar('otro', null, AHORA)).toThrow(ErrorTransicionInvalida);
  });

  it('permite rechazar una aprobación pendiente', () => {
    const a = crear();
    a.rechazar('aprobador', 'no procede', AHORA);
    expect(a.estado).toBe('RECHAZADA');
    expect(a.snapshot().comentario).toBe('no procede');
  });
});

describe('Herramientas y errores de dominio', () => {
  it('esNombreHerramienta distingue nombres válidos de alucinaciones', () => {
    for (const nombre of NOMBRES_HERRAMIENTA) expect(esNombreHerramienta(nombre)).toBe(true);
    expect(esNombreHerramienta('borrar_base_de_datos')).toBe(false);
    expect(esNombreHerramienta('')).toBe(false);
  });

  it('los errores conservan prototipo, código y detalle', () => {
    const error = new ErrorValidacion('mal', { campo: 'x' });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ErrorDominio);
    expect(error.codigo).toBe('VALIDACION');
    expect(error.detalle).toEqual({ campo: 'x' });
  });
});
