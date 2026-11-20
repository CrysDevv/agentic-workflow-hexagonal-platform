import { randomUUID } from 'node:crypto';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { EjecucionProps, JsonObjeto } from '../../domain/entities';
import type {
  AlmacenPropuestasPuerto,
  ColaTareasPuerto,
  GeneradorIdPuerto,
  NotificadorPuerto,
  RelojPuerto,
} from '../../domain/ports';
import type { ProcesarEjecucionCasoUso } from '../../application/use-cases';
import { almacenCorrelacion, conSpan } from '../../config/config';

// ============================== Reloj e identificadores ==============================
export class RelojSistema implements RelojPuerto {
  ahora(): Date {
    return new Date();
  }
}

export class GeneradorUuid implements GeneradorIdPuerto {
  nuevo(): string {
    return randomUUID();
  }
}

// ============================== S3: propuestas y notificaciones ==============================
export class AlmacenS3 implements AlmacenPropuestasPuerto {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  async guardar(clave: string, contenido: JsonObjeto): Promise<string> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: clave,
        Body: JSON.stringify(contenido),
        ContentType: 'application/json',
      }),
    );
    return `s3://${this.bucket}/${clave}`;
  }
}

/** Bandeja de salida durable en S3: cada notificación se persiste como documento JSON. */
export class NotificadorOutboxS3 implements NotificadorPuerto {
  private readonly log = new Logger('Notificador');

  constructor(
    private readonly almacen: AlmacenPropuestasPuerto,
    private readonly ids: GeneradorIdPuerto,
    private readonly reloj: RelojPuerto,
  ) {}

  async enviar(destinatario: string, asunto: string, mensaje: string): Promise<void> {
    const ahora = this.reloj.ahora();
    const id = this.ids.nuevo();
    const ubicacion = await this.almacen.guardar(`notificaciones/${ahora.toISOString().slice(0, 10)}/${id}.json`, {
      id,
      destinatario,
      asunto,
      mensaje,
      creadaEn: ahora.toISOString(),
      canal: 'correo',
    });
    this.log.log(`Notificación ${id} registrada en ${ubicacion}`);
  }
}

// ============================== Colas de tareas (Redis / SQS) ==============================
export interface TareaCola {
  readonly ejecucionId: string;
  readonly correlationId: string;
  readonly recibo: string;
}

export interface FuenteTareas {
  siguiente(): Promise<TareaCola | null>;
  confirmar(tarea: TareaCola): Promise<void>;
  descartar(tarea: TareaCola): Promise<void>;
  recuperarHuerfanas?(): Promise<number>;
  cerrar(): Promise<void>;
}

export type ColaCompleta = ColaTareasPuerto & FuenteTareas;

function interpretar(cuerpo: string): { ejecucionId: string; correlationId: string } | null {
  try {
    const valor: unknown = JSON.parse(cuerpo);
    if (typeof valor === 'object' && valor !== null) {
      const o = valor as Record<string, unknown>;
      const ejecucionId = o['ejecucionId'];
      const correlationId = o['correlationId'];
      if (typeof ejecucionId === 'string' && typeof correlationId === 'string') {
        return { ejecucionId, correlationId };
      }
    }
  } catch {
    return null;
  }
  return null;
}

const COLA = 'agentic:cola:tareas';
const PROCESANDO = 'agentic:cola:procesando';
const LEASES = 'agentic:cola:leases';
const MUERTAS = 'agentic:cola:muertas';
const VISIBILIDAD_POR_DEFECTO_MS = 60_000;
const MAX_REINTENTOS_HUERFANA = 3;

export class RedisCola implements ColaCompleta {
  private readonly bloqueante: Redis;
  private readonly log = new Logger('RedisCola');

  constructor(
    private readonly redis: Redis,
    private readonly visibilidadMs: number = VISIBILIDAD_POR_DEFECTO_MS,
  ) {
    this.bloqueante = redis.duplicate({ maxRetriesPerRequest: null });
    this.bloqueante.on('error', () => undefined);
  }

  async encolar(ejecucionId: string, correlationId: string): Promise<void> {
    await this.redis.lpush(COLA, JSON.stringify({ ejecucionId, correlationId, reintentos: 0 }));
  }

  async siguiente(): Promise<TareaCola | null> {
    const crudo = await this.bloqueante.blmove(COLA, PROCESANDO, 'RIGHT', 'LEFT', 2);
    if (crudo === null) return null;
    const tarea = interpretar(crudo);
    if (tarea === null) {
      await this.redis.multi().lrem(PROCESANDO, 1, crudo).zrem(LEASES, crudo).lpush(MUERTAS, crudo).exec();
      return null;
    }
    await this.redis.zadd(LEASES, Date.now() + this.visibilidadMs, crudo);
    return { ...tarea, recibo: crudo };
  }

  async confirmar(tarea: TareaCola): Promise<void> {
    await this.redis.multi().lrem(PROCESANDO, 1, tarea.recibo).zrem(LEASES, tarea.recibo).exec();
  }

  async descartar(tarea: TareaCola): Promise<void> {
    await this.redis
      .multi()
      .lrem(PROCESANDO, 1, tarea.recibo)
      .zrem(LEASES, tarea.recibo)
      .lpush(MUERTAS, tarea.recibo)
      .exec();
  }

  /** Reencola tareas cuyo lease expiró por caída/reinicio de un pod (o las envía a DLQ tras max reintentos). */
  async recuperarHuerfanas(ahoraMs: number = Date.now()): Promise<number> {
    const expiradas = await this.redis.zrangebyscore(LEASES, '-inf', ahoraMs, 'LIMIT', 0, 25);
    let recuperadas = 0;
    for (const crudo of expiradas) {
      const quitada = await this.redis.zrem(LEASES, crudo);
      if (quitada === 0) continue; // otra réplica ya reclamó esta tarea expirada
      await this.redis.lrem(PROCESANDO, 1, crudo);

      let reintentos = 0;
      let payload: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(crudo);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
          reintentos = typeof payload['reintentos'] === 'number' ? payload['reintentos'] : 0;
        }
      } catch {
        payload = null;
      }

      if (payload === null || reintentos >= MAX_REINTENTOS_HUERFANA) {
        await this.redis.lpush(MUERTAS, crudo);
        this.log.warn(`Tarea huérfana enviada a DLQ (${MUERTAS}) tras ${reintentos} reintentos`);
      } else {
        const siguientePayload = JSON.stringify({ ...payload, reintentos: reintentos + 1 });
        await this.redis.lpush(COLA, siguientePayload);
        this.log.warn(`Tarea huérfana reencolada (intento ${reintentos + 1}/${MAX_REINTENTOS_HUERFANA})`);
      }
      recuperadas += 1;
    }
    return recuperadas;
  }

  async cerrar(): Promise<void> {
    this.bloqueante.disconnect();
  }
}

export class SqsCola implements ColaCompleta {
  constructor(
    private readonly sqs: SQSClient,
    private readonly urlCola: string,
  ) {}

  async encolar(ejecucionId: string, correlationId: string): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.urlCola,
        MessageBody: JSON.stringify({ ejecucionId, correlationId }),
      }),
    );
  }

  async siguiente(): Promise<TareaCola | null> {
    const r = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.urlCola,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
        VisibilityTimeout: 60,
      }),
    );
    const mensaje = r.Messages?.[0];
    if (mensaje === undefined || mensaje.Body === undefined || mensaje.ReceiptHandle === undefined) return null;
    const tarea = interpretar(mensaje.Body);
    if (tarea === null) {
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.urlCola, ReceiptHandle: mensaje.ReceiptHandle }));
      return null;
    }
    return { ...tarea, recibo: mensaje.ReceiptHandle };
  }

  async confirmar(tarea: TareaCola): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.urlCola, ReceiptHandle: tarea.recibo }));
  }

  /** El mensaje reaparece al vencer la visibilidad y tras 5 recepciones pasa a la DLQ. */
  async descartar(): Promise<void> {
    return;
  }

  async cerrar(): Promise<void> {
    return;
  }
}

// ============================== Trabajador de la cola ==============================
const pausa = (ms: number): Promise<void> => new Promise<void>((resolver) => setTimeout(resolver, ms));

export class TrabajadorCola implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('TrabajadorCola');
  private activo = false;
  private bucle: Promise<void> | null = null;

  constructor(
    private readonly fuente: FuenteTareas,
    private readonly caso: ProcesarEjecucionCasoUso,
    private readonly alFinalizar: (ejecucion: EjecucionProps) => void,
  ) {}

  private temporizadorReaper: ReturnType<typeof setInterval> | null = null;

  onApplicationBootstrap(): void {
    this.activo = true;
    if (this.fuente.recuperarHuerfanas !== undefined) {
      void this.fuente.recuperarHuerfanas().catch(() => undefined);
      this.temporizadorReaper = setInterval(() => {
        if (this.activo && this.fuente.recuperarHuerfanas !== undefined) {
          void this.fuente.recuperarHuerfanas().catch(() => undefined);
        }
      }, 15_000);
      this.temporizadorReaper.unref();
    }
    this.bucle = this.correr();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.detener();
  }

  async detener(): Promise<void> {
    this.activo = false;
    if (this.temporizadorReaper !== null) {
      clearInterval(this.temporizadorReaper);
      this.temporizadorReaper = null;
    }
    if (this.bucle !== null) {
      await this.bucle;
      this.bucle = null;
    }
    await this.fuente.cerrar();
  }

  private async correr(): Promise<void> {
    while (this.activo) {
      try {
        const tarea = await this.fuente.siguiente();
        if (tarea === null) continue;
        try {
          await almacenCorrelacion.run(tarea.correlationId, () =>
            conSpan('agente.procesar_ejecucion', { ejecucion_id: tarea.ejecucionId }, async () => {
              const resultado = await this.caso.ejecutar(tarea.ejecucionId);
              this.alFinalizar(resultado);
            }),
          );
          await this.fuente.confirmar(tarea);
        } catch (error) {
          this.log.error(
            `Falló la ejecución ${tarea.ejecucionId}: ${error instanceof Error ? error.message : 'error desconocido'}`,
          );
          await this.fuente.descartar(tarea);
        }
      } catch (error) {
        if (!this.activo) break;
        this.log.error(`Error al consumir la cola: ${error instanceof Error ? error.message : 'error desconocido'}`);
        await pausa(1000);
      }
    }
  }
}
