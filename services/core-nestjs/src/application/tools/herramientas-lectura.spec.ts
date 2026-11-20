import { LlmLocalDeterminista } from '../../infrastructure/llm/llm.adapters';
import { FLUJO_PRUEBA, crearEntorno, sembrarEjecucion } from '../../testing/fakes';
import { NOMBRES_HERRAMIENTA, Dinero, type FlujoDefinicion } from '../../domain/entities';

const FLUJO_COPILOTO: FlujoDefinicion = {
  id: '33333333-3333-4333-8333-333333333333',
  nombre: 'asistente-operativo',
  descripcion: 'Flujo de lectura operativa del sistema',
  version: 1,
  herramientasPermitidas: [...NOMBRES_HERRAMIENTA],
  umbralAprobacion: Dinero.deUsd(5000),
  activo: true,
};

describe('Capacidades ampliadas de lectura e inspección del agente', () => {
  it('permite al agente leer flujos, ejecuciones previas, propuestas S3, auditoría y catálogo', async () => {
    const env = crearEntorno({ llm: new LlmLocalDeterminista() });
    env.flujos.agregar(FLUJO_COPILOTO);
    // Sembramos una propuesta previa en S3 y una ejecución previa
    await env.almacen.guardar('propuestas/e-prev/p-1.json', {
      propuestaId: 'p-1',
      cliente: 'Acme SA',
      totalUsd: 1150,
    });
    const previa = await sembrarEjecucion(env, { cliente: 'Acme SA', items: [{ sku: 'HW-LAP-001', cantidad: 1 }] }, FLUJO_PRUEBA);
    await env.motor.ejecutar(previa.id);

    const envCopiloto = {
      ...env,
    };
    const ejConsulta = await sembrarEjecucion(
      envCopiloto,
      { consulta: 'Resume propuestas emitidas para Acme SA y estado de auditoría', cliente: 'Acme SA' },
      FLUJO_COPILOTO,
    );
    const res = await envCopiloto.motor.ejecutar(ejConsulta.id);

    expect(res.estado).toBe('COMPLETADA');
    const salida = res.snapshot().resultado as Record<string, unknown>;
    expect(salida['estado']).toBe('CONSULTA_COMPLETADA');
    const datosLeidos = salida['datosLeidos'] as Record<string, unknown[]>;
    expect(datosLeidos['propuestas']?.length).toBeGreaterThanOrEqual(1);
    expect(datosLeidos['catalogo']?.length).toBeGreaterThanOrEqual(1);
  });
});
