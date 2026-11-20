import type { Pool } from 'pg';
import { AprobacionHumana, ErrorTransicionInvalida } from '../../domain/entities';
import { AprobacionPostgres } from './postgres.adapters';

describe('AprobacionPostgres: concurrencia optimista', () => {
  it('lanza ErrorTransicionInvalida (409) cuando rowCount es 0 por resolución concurrente', async () => {
    const query = jest.fn(async (_sql: string) => ({ rows: [], rowCount: 0 }));
    const repo = new AprobacionPostgres({ query } as unknown as Pool);
    const aprobacion = AprobacionHumana.crear({
      id: '11111111-1111-4111-8111-111111111111',
      ejecucionId: '22222222-2222-4222-8222-222222222222',
      pasoId: '33333333-3333-4333-8333-333333333333',
      accionPropuesta: { herramienta: 'emitir_propuesta_comercial' },
      motivo: 'Supera umbral',
      montoUsd: 5750,
      ahora: new Date('2026-01-15T12:00:00.000Z'),
    });
    aprobacion.aprobar('aprobador-2', 'Segundo intento concurrente', new Date('2026-01-15T12:01:00.000Z'));

    await expect(repo.guardar(aprobacion)).rejects.toBeInstanceOf(ErrorTransicionInvalida);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("WHERE id = $1");
    expect(query.mock.calls[0]?.[0]).toContain("AND estado = 'PENDIENTE'");
  });
});
