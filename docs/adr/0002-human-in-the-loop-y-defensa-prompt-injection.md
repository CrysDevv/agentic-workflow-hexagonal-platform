# ADR-0002: Patrón Human-in-the-Loop y defensa Anti-Prompt Injection

- **Estado:** Aceptado
- **Fecha:** 2026-11-19
- **Decisores:** Autor del proyecto (CrysDevv)
- **Etiquetas:** seguridad, OWASP-LLM01, OWASP-LLM06, agentes

## Contexto

El agente puede emitir propuestas comerciales y enviar notificaciones. Dos riesgos del OWASP Top 10 para LLM aplican
directamente:

- **LLM01 (Prompt Injection):** instrucciones maliciosas en la entrada del usuario o, de forma indirecta, en datos
  devueltos por herramientas (por ejemplo, una descripción de catálogo alterada).
- **LLM06 (Excessive Agency):** el modelo podría invocar herramientas no previstas o saltarse controles presupuestarios.

Ninguna defensa basada solo en el prompt es fiable; las decisiones de seguridad no pueden delegarse al modelo.

## Decisión

Aplicar **defensa en profundidad**, con controles deterministas impuestos por el motor y no por el modelo.

### 1. Human-in-the-Loop (HITL)

- Las herramientas se declaran `critica` (hoy: `emitir_propuesta_comercial`) y estiman su monto antes de ejecutarse.
- Si `monto > umbral` del flujo (`umbral_aprobacion_usd`), el `MotorAgente` **no ejecuta** la herramienta: persiste el
  paso como `PENDIENTE`, crea una `AprobacionHumana` y pasa la ejecución a `PAUSADA_APROBACION`.
- Un humano con rol `APROBADOR` o `ADMIN` resuelve la aprobación (`POST /aprobaciones/:id/resolver`):
  - `APROBAR`: la ejecución se reanuda y ejecuta exactamente la acción normalizada que el humano vio.
  - `RECHAZAR`: el paso queda `BLOQUEADO` y la ejecución `RECHAZADA`; la acción nunca se ejecuta.
- Una aprobación se resuelve una sola vez (la segunda resolución responde 409). Todo queda en `auditoria_seguridad`,
  una tabla **append-only** protegida con un trigger que impide `UPDATE` y `DELETE`.
- El umbral lo impone el motor: aunque el modelo omita `validar_umbral_presupuestario`, la herramienta crítica se pausa.

### 2. Guardrail anti-prompt-injection (`GuardrailPromptInjection`)

- Se evalúa en **tres puntos de confianza**: la entrada (ingreso HTTP/webhook y al iniciar la ejecución), cada **decisión
  del LLM** y cada **salida de herramienta** (mitiga inyección indirecta).
- Normaliza el texto (NFKD, sin diacríticos ni caracteres invisibles, minúsculas) y concatena todos los campos para
  resistir la fragmentación del payload.
- Aplica reglas ponderadas (ignorar instrucciones, revelar el prompt, suplantar rol, jailbreak, etiquetas de rol,
  omitir controles, exfiltrar secretos, payloads peligrosos, ofuscación) y bloquea con puntaje >= 5.
- Limita profundidad, cantidad de elementos y longitud para evitar abuso de recursos.
- El adaptador de Claude envuelve el contexto en `<datos_no_confiables>` y neutraliza etiquetas de cierre falsas.
- La respuesta del API es `422 application/problem+json` con las reglas activadas; se audita con la severidad calculada.

### 3. Mínimo privilegio para el agente

- Cada flujo declara una **lista blanca** de herramientas; cualquier nombre fuera de ella (incluidas alucinaciones) bloquea
  el paso, rechaza la ejecución y genera un evento `HERRAMIENTA_NO_PERMITIDA`.
- Las entradas de herramientas se validan con esquemas estrictos y se limitan los pasos por ejecución (8 por defecto).

### 4. Controles de borde complementarios

- Webhooks firmados con HMAC-SHA256 sobre `timestamp.cuerpo`, ventana de 300 s y detección de replay en Redis.
- Autenticación con JWT o `X-API-Key` (hash SHA-256, comparación en tiempo constante) y roles `ADMIN`/`APROBADOR`.
- Rate limiting en Redis y errores RFC 7807 que no filtran detalles internos.

## Consecuencias

**Positivas**

- Un modelo comprometido o engañado no puede ejecutar acciones críticas sin aprobación humana ni usar herramientas fuera
  de su flujo.
- Evidencia verificable: pruebas unitarias, de integración y E2E cubren cada control; el Simulador de la consola permite
  demostrarlos en vivo.

**Negativas / limitaciones**

- Las reglas por patrones son heurísticas: pueden producir falsos positivos y no detectan toda paráfrasis o idioma. Es una
  capa más, no una garantía; debe complementarse con clasificadores especializados y revisión continua de reglas.
- El HITL añade latencia a las acciones críticas y requiere un aprobador disponible; no hay expiración automática de
  aprobaciones implementada (el estado `EXPIRADA` existe en el modelo para una evolución futura).
- Un aprobador malicioso o descuidado sigue siendo un riesgo: se mitiga con auditoría y roles, no se elimina.

## Alternativas consideradas

- **Defensa solo con prompt del sistema:** insuficiente y fácil de eludir.
- **Aprobación humana para todas las acciones:** elimina la automatización; se prefiere aprobación por umbral.
- **Clasificador LLM como único guardrail:** costo, latencia y no determinismo; se considera una capa adicional futura.
