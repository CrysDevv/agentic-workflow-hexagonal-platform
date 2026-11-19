import { createHmac } from 'node:crypto';
import type { Redis } from 'ioredis';
import { RedisFalso } from '../../testing/fakes';
import { RegistroClavesApi, VerificadorWebhook } from './security';

const SECRETO = 'secreto-de-webhook-para-pruebas-0123456789';
const CUERPO = Buffer.from(JSON.stringify({ cliente: 'Acme SA', items: [{ sku: 'SW-LIC-010', cantidad: 1 }] }), 'utf8');

const ahoraSegundos = (): number => Math.floor(Date.now() / 1000);

function crearVerificador(): VerificadorWebhook {
  return new VerificadorWebhook(SECRETO, new RedisFalso() as unknown as Redis);
}

describe('RegistroClavesApi (SHA-256)', () => {
  const registro = new RegistroClavesApi([
    { nombre: 'admin', rol: 'ADMIN', clave: 'a'.repeat(30) },
    { nombre: 'aprobador', rol: 'APROBADOR', clave: 'b'.repeat(30) },
  ]);

  it('resuelve el principal y el rol de una clave válida', () => {
    expect(registro.validar('a'.repeat(30))).toEqual({ nombre: 'admin', rol: 'ADMIN', via: 'api-key' });
    expect(registro.validar('b'.repeat(30))).toEqual({ nombre: 'aprobador', rol: 'APROBADOR', via: 'api-key' });
  });

  it('rechaza claves desconocidas, vacías o de distinta longitud', () => {
    expect(registro.validar('c'.repeat(30))).toBeNull();
    expect(registro.validar('')).toBeNull();
    expect(registro.validar('a')).toBeNull();
    expect(registro.validar('a'.repeat(300))).toBeNull();
  });
});

describe('VerificadorWebhook (HMAC-SHA256)', () => {
  it('genera firmas compatibles con HMAC-SHA256 sobre "timestamp.cuerpo"', () => {
    const v = crearVerificador();
    const ts = String(ahoraSegundos());
    const esperada = createHmac('sha256', SECRETO).update(`${ts}.`).update(CUERPO).digest('hex');
    expect(v.generarFirma(ts, CUERPO)).toBe(`sha256=${esperada}`);
  });

  it('acepta una firma válida', async () => {
    const v = crearVerificador();
    const ts = String(ahoraSegundos());
    expect(await v.verificar(CUERPO, v.generarFirma(ts, CUERPO), ts)).toEqual({ valido: true });
  });

  it('detecta solicitudes repetidas (replay)', async () => {
    const v = crearVerificador();
    const ts = String(ahoraSegundos());
    const firma = v.generarFirma(ts, CUERPO);
    await v.verificar(CUERPO, firma, ts);
    expect(await v.verificar(CUERPO, firma, ts)).toEqual({
      valido: false,
      motivo: 'Solicitud repetida (replay) detectada',
    });
  });

  it('rechaza un cuerpo alterado', async () => {
    const v = crearVerificador();
    const ts = String(ahoraSegundos());
    const firma = v.generarFirma(ts, CUERPO);
    const alterado = Buffer.from(CUERPO.toString('utf8').replace('Acme', 'Evil'), 'utf8');
    expect(await v.verificar(alterado, firma, ts)).toEqual({ valido: false, motivo: 'Firma no coincide' });
  });

  it('rechaza una firma generada con otro secreto', async () => {
    const v = crearVerificador();
    const ts = String(ahoraSegundos());
    const ajena = new VerificadorWebhook('otro-secreto-distinto-de-32-caracteres!!', new RedisFalso() as unknown as Redis);
    expect(await v.verificar(CUERPO, ajena.generarFirma(ts, CUERPO), ts)).toEqual({
      valido: false,
      motivo: 'Firma no coincide',
    });
  });

  it('rechaza marcas de tiempo fuera de la ventana permitida', async () => {
    const v = crearVerificador();
    const viejo = String(ahoraSegundos() - 1000);
    expect(await v.verificar(CUERPO, v.generarFirma(viejo, CUERPO), viejo)).toEqual({
      valido: false,
      motivo: 'Marca de tiempo fuera de la ventana permitida',
    });
  });

  it('rechaza cabeceras ausentes o con formato inválido', async () => {
    const v = crearVerificador();
    const ts = String(ahoraSegundos());
    expect((await v.verificar(CUERPO, undefined, ts)).valido).toBe(false);
    expect((await v.verificar(CUERPO, v.generarFirma(ts, CUERPO), undefined)).valido).toBe(false);
    expect(await v.verificar(CUERPO, 'abc', ts)).toEqual({ valido: false, motivo: 'Formato de firma inválido' });
    expect(await v.verificar(CUERPO, v.generarFirma(ts, CUERPO), 'ayer')).toEqual({
      valido: false,
      motivo: 'X-Timestamp debe estar en segundos Unix',
    });
  });
});
