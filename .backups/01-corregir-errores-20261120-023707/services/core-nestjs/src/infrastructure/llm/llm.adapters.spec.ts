import { GuardrailPromptInjection } from '../../application/guardrails/prompt-injection.guardrail';
import type { JsonObjeto, NombreHerramienta } from '../../domain/entities';
import type { ContextoRazonamiento } from '../../domain/ports';
import { LlmAnthropic, LlmLocalDeterminista } from './llm.adapters';

const TODAS: NombreHerramienta[] = [
  'consultar_proveedores',
  'consultar_catalogo',
  'validar_umbral_presupuestario',
  'emitir_propuesta_comercial',
  'notificar',
];

function contexto(entrada: JsonObjeto, historial: ContextoRazonamiento['historial'] = []): ContextoRazonamiento {
  return {
    ejecucionId: 'e-1',
    flujo: { nombre: 'cotizacion-comercial', descripcion: 'Pruebas' },
    entrada,
    herramientas: TODAS.map((nombre) => ({ nombre, descripcion: `Descripción de ${nombre}` })),
    historial,
    pasoActual: historial.length + 1,
    maxPasos: 8,
  };
}

const ENTRADA: JsonObjeto = { cliente: 'Acme SA', items: [{ sku: 'HW-LAP-001', cantidad: 2 }] };

const PASO_PROVEEDORES = {
  orden: 1,
  herramienta: 'consultar_proveedores',
  entrada: {},
  salida: { proveedores: [] },
  estado: 'COMPLETADO' as const,
};

const pasoCatalogo = (sku: string) => ({
  orden: 2,
  herramienta: 'consultar_catalogo',
  entrada: {},
  salida: { articulos: [{ sku, precioUnitarioUsd: 1150 }] },
  estado: 'COMPLETADO' as const,
});

describe('LlmLocalDeterminista', () => {
  const llm = new LlmLocalDeterminista();

  it('termina con ENTRADA_INVALIDA si no hay artículos válidos', async () => {
    const d = await llm.decidir(contexto({ cliente: 'Acme' }));
    expect(d).toMatchObject({ tipo: 'FINAL', resultado: { estado: 'ENTRADA_INVALIDA' } });
  });

  it('comienza consultando proveedores y luego el catálogo', async () => {
    const primero = await llm.decidir(contexto(ENTRADA));
    expect(primero).toMatchObject({ tipo: 'HERRAMIENTA', herramienta: 'consultar_proveedores' });
    const segundo = await llm.decidir(contexto(ENTRADA, [PASO_PROVEEDORES]));
    expect(segundo).toMatchObject({ tipo: 'HERRAMIENTA', herramienta: 'consultar_catalogo' });
  });

  it('valoriza el total y valida el umbral', async () => {
    const d = await llm.decidir(contexto(ENTRADA, [PASO_PROVEEDORES, pasoCatalogo('HW-LAP-001')]));
    expect(d).toMatchObject({
      tipo: 'HERRAMIENTA',
      herramienta: 'validar_umbral_presupuestario',
      entrada: { montoUsd: 2300 },
    });
  });

  it('termina con SKU_NO_ENCONTRADO si el catálogo no contiene el artículo', async () => {
    const d = await llm.decidir(contexto(ENTRADA, [PASO_PROVEEDORES, pasoCatalogo('OTRO-SKU')]));
    expect(d).toMatchObject({ tipo: 'FINAL', resultado: { estado: 'SKU_NO_ENCONTRADO', skus: ['HW-LAP-001'] } });
  });

  it('finaliza con la propuesta emitida cuando todos los pasos están completos', async () => {
    const historial: ContextoRazonamiento['historial'] = [
      PASO_PROVEEDORES,
      pasoCatalogo('HW-LAP-001'),
      {
        orden: 3,
        herramienta: 'validar_umbral_presupuestario',
        entrada: {},
        salida: { requiereAprobacion: false },
        estado: 'COMPLETADO',
      },
      {
        orden: 4,
        herramienta: 'emitir_propuesta_comercial',
        entrada: {},
        salida: { propuestaId: 'prop-1', ubicacion: 's3://b/k' },
        estado: 'COMPLETADO',
      },
    ];
    const d = await llm.decidir(contexto(ENTRADA, historial));
    expect(d).toMatchObject({
      tipo: 'FINAL',
      resultado: { estado: 'PROPUESTA_EMITIDA', totalUsd: 2300, propuestaId: 'prop-1', notificado: false },
    });
  });
});

describe('LlmAnthropic', () => {
  const guardrail = new GuardrailPromptInjection();
  type Init = { headers: Record<string, string>; body: string };

  function crearFetch(cuerpo: unknown, ok = true, status = 200) {
    return jest.fn(async (_url: string, _init: Init) => ({ ok, status, json: async () => cuerpo }));
  }

  it('envía la clave, encapsula el contexto como datos no confiables y parsea la decisión', async () => {
    const fetchFalso = crearFetch({
      content: [
        {
          type: 'text',
          text: 'Respuesta: {"tipo":"HERRAMIENTA","herramienta":"consultar_catalogo","entrada":{"limite":5},"razonamiento":"Consulto"}',
        },
      ],
    });
    const llm = new LlmAnthropic('clave-secreta', 'modelo-x', guardrail, fetchFalso as unknown as typeof fetch);

    const d = await llm.decidir(contexto(ENTRADA));

    expect(d).toEqual({
      tipo: 'HERRAMIENTA',
      herramienta: 'consultar_catalogo',
      entrada: { limite: 5 },
      razonamiento: 'Consulto',
    });
    const [url, init] = fetchFalso.mock.calls[0] as [string, Init];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('clave-secreta');
    const cuerpo = JSON.parse(init.body) as { model: string; system: string; messages: Array<{ content: string }> };
    expect(cuerpo.model).toBe('modelo-x');
    expect(cuerpo.system).toContain('consultar_catalogo');
    expect(cuerpo.messages[0]?.content.startsWith('<datos_no_confiables')).toBe(true);
  });

  it('acepta una decisión FINAL', async () => {
    const fetchFalso = crearFetch({
      content: [{ type: 'text', text: '{"tipo":"FINAL","resultado":{"ok":true},"razonamiento":"listo"}' }],
    });
    const llm = new LlmAnthropic('k', 'm', guardrail, fetchFalso as unknown as typeof fetch);
    expect(await llm.decidir(contexto(ENTRADA))).toMatchObject({ tipo: 'FINAL', resultado: { ok: true } });
  });

  it('falla ante estados HTTP no exitosos', async () => {
    const llm = new LlmAnthropic('k', 'm', guardrail, crearFetch({}, false, 529) as unknown as typeof fetch);
    await expect(llm.decidir(contexto(ENTRADA))).rejects.toThrow('529');
  });

  it('falla ante respuestas sin JSON o fuera de contrato', async () => {
    const sinJson = crearFetch({ content: [{ type: 'text', text: 'no sé qué hacer' }] });
    const fueraContrato = crearFetch({ content: [{ type: 'text', text: '{"tipo":"OTRO"}' }] });
    const sinTexto = crearFetch({ content: [] });
    for (const f of [sinJson, fueraContrato, sinTexto]) {
      const llm = new LlmAnthropic('k', 'm', guardrail, f as unknown as typeof fetch);
      await expect(llm.decidir(contexto(ENTRADA))).rejects.toThrow();
    }
  });
});
