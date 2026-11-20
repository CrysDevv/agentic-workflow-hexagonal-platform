import { Dinero, ErrorNoEncontrado, ErrorValidacion, type JsonObjeto } from '../../domain/entities';
import {
  exigirArreglo,
  exigirNumero,
  exigirObjeto,
  exigirTexto,
  numeroOpcional,
  RegistroHerramientas,
  textoOpcional,
  type ContextoHerramienta,
  type DefinicionHerramienta,
  type DependenciasHerramientas,
} from './tool-registry';

// ---------------------------------------------------------------
// consultar_proveedores
// ---------------------------------------------------------------
interface EntradaProveedores {
  categoria?: string;
  limite: number;
}

function consultarProveedores(d: DependenciasHerramientas): DefinicionHerramienta<EntradaProveedores, JsonObjeto> {
  return {
    nombre: 'consultar_proveedores',
    descripcion: 'Lista proveedores activos (con calificación y país) opcionalmente filtrados por categoría.',
    critica: false,
    validarEntrada(cruda: unknown): EntradaProveedores {
      const o = exigirObjeto(cruda, 'entrada');
      return {
        categoria: textoOpcional(o['categoria'], 'categoria', 60),
        limite: numeroOpcional(o['limite'], 'limite', { min: 1, max: 25, entero: true }, 10),
      };
    },
    async ejecutar(entrada: EntradaProveedores): Promise<JsonObjeto> {
      const articulos = await d.catalogo.buscar({ categoria: entrada.categoria, limite: 100 });
      const porProveedor = new Map<
        string,
        { proveedor: string; pais: string; calificacion: number; categorias: Set<string>; articulos: number }
      >();
      for (const a of articulos) {
        const actual = porProveedor.get(a.nombre);
        if (actual) {
          actual.articulos += 1;
          actual.categorias.add(a.categoria);
        } else {
          porProveedor.set(a.nombre, {
            proveedor: a.nombre,
            pais: a.pais,
            calificacion: a.calificacion,
            categorias: new Set<string>([a.categoria]),
            articulos: 1,
          });
        }
      }
      const proveedores = [...porProveedor.values()]
        .sort((x, y) => y.calificacion - x.calificacion || x.proveedor.localeCompare(y.proveedor))
        .slice(0, entrada.limite)
        .map((p) => ({
          proveedor: p.proveedor,
          pais: p.pais,
          calificacion: p.calificacion,
          categorias: [...p.categorias].sort(),
          articulos: p.articulos,
        }));
      return { proveedores, total: porProveedor.size };
    },
  };
}

// ---------------------------------------------------------------
// consultar_catalogo
// ---------------------------------------------------------------
interface EntradaCatalogo {
  categoria?: string;
  texto?: string;
  sku?: string;
  limite: number;
}

function consultarCatalogo(d: DependenciasHerramientas): DefinicionHerramienta<EntradaCatalogo, JsonObjeto> {
  return {
    nombre: 'consultar_catalogo',
    descripcion: 'Busca artículos del catálogo por categoría, texto libre o SKU y devuelve precio y plazo.',
    critica: false,
    validarEntrada(cruda: unknown): EntradaCatalogo {
      const o = exigirObjeto(cruda, 'entrada');
      return {
        categoria: textoOpcional(o['categoria'], 'categoria', 60),
        texto: textoOpcional(o['texto'], 'texto', 120),
        sku: textoOpcional(o['sku'], 'sku', 40),
        limite: numeroOpcional(o['limite'], 'limite', { min: 1, max: 25, entero: true }, 10),
      };
    },
    async ejecutar(entrada: EntradaCatalogo): Promise<JsonObjeto> {
      const articulos = await d.catalogo.buscar({
        categoria: entrada.categoria,
        texto: entrada.texto,
        sku: entrada.sku,
        limite: entrada.limite,
      });
      return {
        articulos: articulos.map((a) => ({
          sku: a.sku,
          proveedor: a.nombre,
          categoria: a.categoria,
          descripcion: a.descripcion,
          precioUnitarioUsd: a.precioUnitarioUsd,
          plazoEntregaDias: a.plazoEntregaDias,
        })),
        total: articulos.length,
      };
    },
  };
}

// ---------------------------------------------------------------
// validar_umbral_presupuestario
// ---------------------------------------------------------------
interface EntradaUmbral {
  montoUsd: number;
}

function validarUmbral(): DefinicionHerramienta<EntradaUmbral, JsonObjeto> {
  return {
    nombre: 'validar_umbral_presupuestario',
    descripcion: 'Compara un monto en USD con el umbral de aprobación del flujo e indica si requiere aprobación humana.',
    critica: false,
    validarEntrada(cruda: unknown): EntradaUmbral {
      const o = exigirObjeto(cruda, 'entrada');
      return { montoUsd: exigirNumero(o['montoUsd'], 'montoUsd', { min: 0, max: 1_000_000_000 }) };
    },
    async ejecutar(entrada: EntradaUmbral, ctx: ContextoHerramienta): Promise<JsonObjeto> {
      const monto = Dinero.deUsd(entrada.montoUsd);
      const umbral = ctx.flujo.umbralAprobacion;
      const requiere = monto.superaA(umbral);
      return {
        montoUsd: monto.usd,
        umbralUsd: umbral.usd,
        requiereAprobacion: requiere,
        margenUsd: requiere ? 0 : (umbral.centavos - monto.centavos) / 100,
      };
    },
  };
}

// ---------------------------------------------------------------
// emitir_propuesta_comercial (crítica: sujeta a umbral)
// ---------------------------------------------------------------
interface ItemPropuesta {
  sku: string;
  cantidad: number;
}
interface EntradaPropuesta {
  cliente: string;
  items: ItemPropuesta[];
  notas?: string;
}
interface LineaPropuesta {
  sku: string;
  proveedor: string;
  descripcion: string;
  cantidad: number;
  precioUnitarioUsd: number;
  subtotalUsd: number;
}

async function resolverLineas(
  d: DependenciasHerramientas,
  entrada: EntradaPropuesta,
): Promise<{ lineas: LineaPropuesta[]; total: Dinero }> {
  const lineas: LineaPropuesta[] = [];
  let total = Dinero.cero();
  for (const item of entrada.items) {
    const [articulo] = await d.catalogo.buscar({ sku: item.sku, limite: 1 });
    if (!articulo || articulo.sku !== item.sku) {
      throw new ErrorNoEncontrado('articulo', item.sku);
    }
    const subtotal = Dinero.deUsd(articulo.precioUnitarioUsd).multiplicar(item.cantidad);
    total = total.sumar(subtotal);
    lineas.push({
      sku: articulo.sku,
      proveedor: articulo.nombre,
      descripcion: articulo.descripcion,
      cantidad: item.cantidad,
      precioUnitarioUsd: articulo.precioUnitarioUsd,
      subtotalUsd: subtotal.usd,
    });
  }
  return { lineas, total };
}

function emitirPropuesta(d: DependenciasHerramientas): DefinicionHerramienta<EntradaPropuesta, JsonObjeto> {
  return {
    nombre: 'emitir_propuesta_comercial',
    descripcion: 'Emite y almacena una propuesta comercial valorizada con precios del catálogo para un cliente.',
    critica: true,
    validarEntrada(cruda: unknown): EntradaPropuesta {
      const o = exigirObjeto(cruda, 'entrada');
      const items = exigirArreglo(o['items'], 'items', 1, 20).map((crudo, indice): ItemPropuesta => {
        const it = exigirObjeto(crudo, `items[${indice}]`);
        return {
          sku: exigirTexto(it['sku'], `items[${indice}].sku`, 40),
          cantidad: exigirNumero(it['cantidad'], `items[${indice}].cantidad`, { min: 1, max: 1000, entero: true }),
        };
      });
      const skus = new Set(items.map((i) => i.sku));
      if (skus.size !== items.length) {
        throw new ErrorValidacion("'items' contiene SKUs duplicados");
      }
      return {
        cliente: exigirTexto(o['cliente'], 'cliente', 120),
        items,
        notas: textoOpcional(o['notas'], 'notas', 1000),
      };
    },
    async estimarMonto(entrada: EntradaPropuesta): Promise<Dinero> {
      return (await resolverLineas(d, entrada)).total;
    },
    async ejecutar(entrada: EntradaPropuesta, ctx: ContextoHerramienta): Promise<JsonObjeto> {
      const { lineas, total } = await resolverLineas(d, entrada);
      const propuestaId = d.ids.nuevo();
      const documento: JsonObjeto = {
        propuestaId,
        ejecucionId: ctx.ejecucionId,
        cliente: entrada.cliente,
        emitidaEn: d.reloj.ahora().toISOString(),
        validezDias: 15,
        lineas: lineas.map((l): JsonObjeto => ({ ...l })),
        totalUsd: total.usd,
        notas: entrada.notas ?? null,
      };
      const ubicacion = await d.almacen.guardar(`propuestas/${ctx.ejecucionId}/${propuestaId}.json`, documento);
      return { propuestaId, ubicacion, totalUsd: total.usd, lineas: lineas.length };
    },
  };
}

// ---------------------------------------------------------------
// notificar
// ---------------------------------------------------------------
interface EntradaNotificar {
  destinatario: string;
  asunto: string;
  mensaje: string;
}

const PATRON_EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

function notificar(d: DependenciasHerramientas): DefinicionHerramienta<EntradaNotificar, JsonObjeto> {
  return {
    nombre: 'notificar',
    descripcion: 'Envía una notificación por correo a un destinatario con asunto y mensaje.',
    critica: false,
    validarEntrada(cruda: unknown): EntradaNotificar {
      const o = exigirObjeto(cruda, 'entrada');
      const destinatario = exigirTexto(o['destinatario'], 'destinatario', 254);
      if (!PATRON_EMAIL.test(destinatario)) {
        throw new ErrorValidacion("'destinatario' debe ser un correo válido", { campo: 'destinatario' });
      }
      return {
        destinatario,
        asunto: exigirTexto(o['asunto'], 'asunto', 150),
        mensaje: exigirTexto(o['mensaje'], 'mensaje', 2000),
      };
    },
    async ejecutar(entrada: EntradaNotificar): Promise<JsonObjeto> {
      await d.notificador.enviar(entrada.destinatario, entrada.asunto, entrada.mensaje);
      return { enviado: true, destinatario: entrada.destinatario };
    },
  };
}


// ---------------------------------------------------------------
// consultar_flujos_disponibles (lectura de políticas y umbrales)
// ---------------------------------------------------------------
function consultarFlujosDisponibles(d: DependenciasHerramientas): DefinicionHerramienta<Record<string, never>, JsonObjeto> {
  return {
    nombre: 'consultar_flujos_disponibles',
    descripcion: 'Lista los flujos operativos activos, sus herramientas permitidas y el umbral USD de aprobación humana.',
    critica: false,
    validarEntrada(cruda: unknown): Record<string, never> {
      exigirObjeto(cruda ?? {}, 'entrada');
      return {};
    },
    async ejecutar(_entrada: Record<string, never>, ctx: ContextoHerramienta): Promise<JsonObjeto> {
      const lista = d.flujos?.listarActivos ? await d.flujos.listarActivos() : [ctx.flujo];
      return {
        flujos: lista.map((f) => ({
          nombre: f.nombre,
          descripcion: f.descripcion,
          version: f.version,
          umbralAprobacionUsd: f.umbralAprobacion.usd,
          herramientasPermitidas: [...f.herramientasPermitidas],
        })),
        total: lista.length,
      };
    },
  };
}

// ---------------------------------------------------------------
// consultar_historial_ejecuciones (lectura de ejecuciones previas)
// ---------------------------------------------------------------
interface EntradaHistorialEjecuciones {
  estado?: string;
  cliente?: string;
  limite: number;
}

function consultarHistorialEjecuciones(
  d: DependenciasHerramientas,
): DefinicionHerramienta<EntradaHistorialEjecuciones, JsonObjeto> {
  return {
    nombre: 'consultar_historial_ejecuciones',
    descripcion: 'Consulta el historial reciente de ejecuciones del agente (estado, origen, entrada, resultado y errores).',
    critica: false,
    validarEntrada(cruda: unknown): EntradaHistorialEjecuciones {
      const o = exigirObjeto(cruda ?? {}, 'entrada');
      return {
        estado: textoOpcional(o['estado'], 'estado', 32),
        cliente: textoOpcional(o['cliente'], 'cliente', 120),
        limite: numeroOpcional(o['limite'], 'limite', { min: 1, max: 30, entero: true }, 10),
      };
    },
    async ejecutar(entrada: EntradaHistorialEjecuciones): Promise<JsonObjeto> {
      if (!d.ejecuciones) return { ejecuciones: [], total: 0 };
      const todas = await d.ejecuciones.listar(50);
      const estadoFiltro = entrada.estado?.toUpperCase();
      const clienteFiltro = entrada.cliente?.toLowerCase();
      const filtradas = todas
        .map((e) => e.snapshot())
        .filter((e) => {
          if (estadoFiltro !== undefined && e.estado !== estadoFiltro) return false;
          if (clienteFiltro !== undefined) {
            const texto = JSON.stringify({ entrada: e.entrada, resultado: e.resultado }).toLowerCase();
            if (!texto.includes(clienteFiltro)) return false;
          }
          return true;
        })
        .slice(0, entrada.limite);

      return {
        ejecuciones: filtradas.map((e) => ({
          id: e.id,
          estado: e.estado,
          origen: e.origen,
          correlationId: e.correlationId,
          iniciadoEn: e.iniciadoEn.toISOString(),
          finalizadoEn: e.finalizadoEn ? e.finalizadoEn.toISOString() : null,
          entrada: e.entrada,
          resultado: e.resultado,
          error: e.error,
        })),
        total: filtradas.length,
      };
    },
  };
}

// ---------------------------------------------------------------
// consultar_propuestas_emitidas (lectura de documentos en S3)
// ---------------------------------------------------------------
interface EntradaPropuestasEmitidas {
  cliente?: string;
  limite: number;
}

function consultarPropuestasEmitidas(
  d: DependenciasHerramientas,
): DefinicionHerramienta<EntradaPropuestasEmitidas, JsonObjeto> {
  return {
    nombre: 'consultar_propuestas_emitidas',
    descripcion: 'Lee propuestas comerciales ya emitidas y almacenadas en Object Storage (S3), filtrables por cliente.',
    critica: false,
    validarEntrada(cruda: unknown): EntradaPropuestasEmitidas {
      const o = exigirObjeto(cruda ?? {}, 'entrada');
      return {
        cliente: textoOpcional(o['cliente'], 'cliente', 120),
        limite: numeroOpcional(o['limite'], 'limite', { min: 1, max: 20, entero: true }, 8),
      };
    },
    async ejecutar(entrada: EntradaPropuestasEmitidas): Promise<JsonObjeto> {
      if (!d.almacen.listar || !d.almacen.leer) {
        return { propuestas: [], total: 0 };
      }
      const claves = await d.almacen.listar('propuestas/', 40);
      const clienteFiltro = entrada.cliente?.toLowerCase();
      const propuestas: JsonObjeto[] = [];
      for (const clave of claves) {
        if (propuestas.length >= entrada.limite) break;
        const doc = await d.almacen.leer(clave);
        if (!doc) continue;
        if (clienteFiltro !== undefined) {
          const clienteDoc = String(doc['cliente'] ?? '').toLowerCase();
          if (!clienteDoc.includes(clienteFiltro)) continue;
        }
        propuestas.push({ claveS3: clave, ...doc });
      }
      return { propuestas, total: propuestas.length };
    },
  };
}

// ---------------------------------------------------------------
// consultar_auditoria_y_estado (lectura de seguridad y pendientes HITL)
// ---------------------------------------------------------------
interface EntradaAuditoriaEstado {
  tipoEvento?: string;
  severidad?: string;
  limite: number;
}

function consultarAuditoriaYEstado(
  d: DependenciasHerramientas,
): DefinicionHerramienta<EntradaAuditoriaEstado, JsonObjeto> {
  return {
    nombre: 'consultar_auditoria_y_estado',
    descripcion: 'Inspecciona eventos recientes de auditoría de seguridad (bloqueos prompt injection, aprobaciones) y pendientes HITL.',
    critica: false,
    validarEntrada(cruda: unknown): EntradaAuditoriaEstado {
      const o = exigirObjeto(cruda ?? {}, 'entrada');
      return {
        tipoEvento: textoOpcional(o['tipoEvento'], 'tipoEvento', 64),
        severidad: textoOpcional(o['severidad'], 'severidad', 16),
        limite: numeroOpcional(o['limite'], 'limite', { min: 1, max: 30, entero: true }, 12),
      };
    },
    async ejecutar(entrada: EntradaAuditoriaEstado): Promise<JsonObjeto> {
      const eventos = d.auditoria?.listarRecientes
        ? await d.auditoria.listarRecientes({
            limite: entrada.limite,
            tipoEvento: entrada.tipoEvento?.toUpperCase(),
            severidad: entrada.severidad?.toUpperCase(),
          })
        : [];
      const pendientes = d.aprobaciones ? await d.aprobaciones.listarPendientes(50) : [];
      return {
        aprobacionesPendientes: pendientes.length,
        eventosRecientes: eventos.map((ev) => ({
          id: ev.id,
          tipoEvento: ev.tipoEvento,
          severidad: ev.severidad,
          actor: ev.actor,
          correlationId: ev.correlationId,
          detalle: ev.detalle,
          creadoEn: ev.creadoEn.toISOString(),
        })),
        totalEventos: eventos.length,
      };
    },
  };
}

// ---------------------------------------------------------------
// cotizar_items_catalogo (cálculo batch exacto sin efectos secundarios)
// ---------------------------------------------------------------
interface EntradaCotizarItems {
  items: ItemPropuesta[];
}

function cotizarItemsCatalogo(d: DependenciasHerramientas): DefinicionHerramienta<EntradaCotizarItems, JsonObjeto> {
  return {
    nombre: 'cotizar_items_catalogo',
    descripcion: 'Calcula precios unitarios, subtotales, total USD, plazo máximo de entrega y si requiere aprobación humana para una lista de SKUs.',
    critica: false,
    validarEntrada(cruda: unknown): EntradaCotizarItems {
      const o = exigirObjeto(cruda, 'entrada');
      const items = exigirArreglo(o['items'], 'items', 1, 20).map((crudo, indice): ItemPropuesta => {
        const it = exigirObjeto(crudo, `items[${indice}]`);
        return {
          sku: exigirTexto(it['sku'], `items[${indice}].sku`, 40),
          cantidad: exigirNumero(it['cantidad'], `items[${indice}].cantidad`, { min: 1, max: 1000, entero: true }),
        };
      });
      return { items };
    },
    async ejecutar(entrada: EntradaCotizarItems, ctx: ContextoHerramienta): Promise<JsonObjeto> {
      const lineas: JsonObjeto[] = [];
      const noEncontrados: string[] = [];
      let total = Dinero.cero();
      let plazoMaximoDias = 0;

      for (const item of entrada.items) {
        const [art] = await d.catalogo.buscar({ sku: item.sku, limite: 1 });
        if (!art || art.sku !== item.sku) {
          noEncontrados.push(item.sku);
          continue;
        }
        const subtotal = Dinero.deUsd(art.precioUnitarioUsd).multiplicar(item.cantidad);
        total = total.sumar(subtotal);
        plazoMaximoDias = Math.max(plazoMaximoDias, art.plazoEntregaDias);
        lineas.push({
          sku: art.sku,
          descripcion: art.descripcion,
          proveedor: art.nombre,
          cantidad: item.cantidad,
          precioUnitarioUsd: art.precioUnitarioUsd,
          subtotalUsd: subtotal.usd,
          plazoEntregaDias: art.plazoEntregaDias,
        });
      }

      return {
        lineas,
        skusNoEncontrados: noEncontrados,
        totalUsd: total.usd,
        plazoMaximoEntregaDias: plazoMaximoDias,
        umbralAprobacionUsd: ctx.flujo.umbralAprobacion.usd,
        requiereAprobacionHumana: total.superaA(ctx.flujo.umbralAprobacion),
      };
    },
  };
}

// ---------------------------------------------------------------
// Fábrica del registro
// ---------------------------------------------------------------
export function crearRegistroHerramientas(deps: DependenciasHerramientas): RegistroHerramientas {
  return new RegistroHerramientas()
    .registrar(consultarProveedores(deps))
    .registrar(consultarCatalogo(deps))
    .registrar(validarUmbral())
    .registrar(emitirPropuesta(deps))
    .registrar(notificar(deps))
    .registrar(consultarFlujosDisponibles(deps))
    .registrar(consultarHistorialEjecuciones(deps))
    .registrar(consultarPropuestasEmitidas(deps))
    .registrar(consultarAuditoriaYEstado(deps))
    .registrar(cotizarItemsCatalogo(deps));
}
