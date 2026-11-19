# ADR-0001: Arquitectura Hexagonal en NestJS

- **Estado:** Aceptado
- **Fecha:** 2026-11-19
- **Decisores:** Autor del proyecto (CrysDevv)
- **Etiquetas:** arquitectura, nestjs, testabilidad

## Contexto

El núcleo (`services/core-nestjs`) orquesta agentes de IA con Tool Calling sobre datos comerciales y administrativos.
Sus requisitos principales son:

- Intercambiar el proveedor LLM (determinista local a costo $0 y Claude API) sin tocar la lógica de negocio.
- Intercambiar la cola de tareas (Redis o SQS) y el almacenamiento (S3 real o LocalStack).
- Probar el motor del agente, el guardrail y la máquina de estados sin levantar PostgreSQL, Redis ni AWS.
- Mantener las reglas críticas (umbral presupuestario, aprobación humana, lista blanca de herramientas) fuera del
  alcance de frameworks y de decisiones del modelo.

Un NestJS "por capas" clásico acopla servicios, repositorios y decoradores, lo que dificulta estas sustituciones y
filtra dependencias de infraestructura hacia el negocio.

## Decisión

Adoptar **Arquitectura Hexagonal (puertos y adaptadores)** con tres capas y dependencias que apuntan solo hacia adentro:

```
infrastructure  ->  application  ->  domain
```

| Capa | Ruta | Contenido | Dependencias permitidas |
|---|---|---|---|
| Dominio | `src/domain/` | Entidades (`EjecucionAgente`, `PasoEjecucion`, `AprobacionHumana`), Value Object `Dinero`, errores de dominio y **puertos** (`LlmPuerto`, `*Repositorio`, `ColaTareasPuerto`, `NotificadorPuerto`, `AlmacenPropuestasPuerto`, `AuditoriaPuerto`, `RelojPuerto`, `GeneradorIdPuerto`) | Ninguna (sin `@nestjs/*`, ORMs ni SDKs) |
| Aplicación | `src/application/` | `MotorAgente`, `RegistroHerramientas` (Tool Registry tipado), `GuardrailPromptInjection`, casos de uso | Solo dominio |
| Infraestructura | `src/infrastructure/` y `src/config/` | Adaptadores PostgreSQL, Redis, SQS/S3, LLM, seguridad (JWT, API Key, HMAC), controladores REST, filtro RFC 7807, métricas | Dominio, aplicación y librerías externas |

Reglas operativas:

1. El ensamblaje (inyección de dependencias) ocurre **únicamente** en `app.module.ts` mediante `useFactory` y tokens
   `Symbol`; las clases de dominio y aplicación no usan decoradores de NestJS.
2. Las entidades encapsulan su máquina de estados (`ErrorTransicionInvalida` ante movimientos ilegales) y exponen
   `snapshot()` para serializar sin filtrar estado interno mutable.
3. El dinero se maneja como centavos enteros (`Dinero`) para evitar errores de coma flotante en el umbral.
4. Las pruebas usan dobles en memoria de cada puerto (`src/testing/fakes.ts`), excluidos del build de producción.

## Consecuencias

**Positivas**

- El motor, el guardrail y los casos de uso se prueban en milisegundos con dobles en memoria; la suite de integración
  ejercita la API HTTP real (controladores, guards y filtro RFC 7807) sin infraestructura externa.
- Cambiar `LLM_PROVIDER` o `QUEUE_DRIVER` es una decisión de configuración, no de código de negocio.
- Las reglas críticas viven en un único lugar auditable (`MotorAgente`), con independencia del modelo.

**Negativas / costos**

- Más archivos y mapeos explícitos (filas SQL a entidades) que un CRUD directo con ORM.
- Requiere disciplina para no importar infraestructura desde dominio o aplicación; se mitiga con revisión de código y
  puede reforzarse con una regla de lint de dependencias.
- Se renuncia a la inyección por decoradores en las capas internas, lo que hace el cableado más verboso.

## Alternativas consideradas

- **NestJS por capas (controller/service/repository con TypeORM):** menos código inicial, pero acopla el negocio al ORM
  y al framework y complica las pruebas aisladas.
- **Clean Architecture con casos de uso por archivo y DTOs por frontera:** conceptualmente cercana; se adoptó la variante
  hexagonal por su vocabulario de puertos/adaptadores, suficiente para este alcance.
- **Módulos NestJS por contexto delimitado:** prematuro para un único contexto; puede introducirse después sin romper
  los puertos.
