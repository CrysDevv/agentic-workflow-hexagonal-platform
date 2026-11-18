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
// Fábrica del registro
// ---------------------------------------------------------------
export function crearRegistroHerramientas(deps: DependenciasHerramientas): RegistroHerramientas {
  return new RegistroHerramientas()
    .registrar(consultarProveedores(deps))
    .registrar(consultarCatalogo(deps))
    .registrar(validarUmbral())
    .registrar(emitirPropuesta(deps))
    .registrar(notificar(deps));
}
