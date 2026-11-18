-- Esquema inicial: agentic-workflow-hexagonal-platform
-- PostgreSQL 16

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------
-- flujos_definicion
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS flujos_definicion (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre                  VARCHAR(120) NOT NULL UNIQUE,
    descripcion             TEXT NOT NULL,
    version                 INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    herramientas_permitidas TEXT[] NOT NULL,
    umbral_aprobacion_usd   NUMERIC(14,2) NOT NULL DEFAULT 5000.00 CHECK (umbral_aprobacion_usd >= 0),
    activo                  BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------
-- ejecuciones_agente
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ejecuciones_agente (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    flujo_id        UUID NOT NULL REFERENCES flujos_definicion(id) ON DELETE RESTRICT,
    estado          VARCHAR(32) NOT NULL DEFAULT 'PENDIENTE'
                    CHECK (estado IN ('PENDIENTE','EN_EJECUCION','PAUSADA_APROBACION','COMPLETADA','RECHAZADA','FALLIDA')),
    origen          VARCHAR(32) NOT NULL DEFAULT 'API'
                    CHECK (origen IN ('API','WEBHOOK','CONSOLA')),
    entrada         JSONB NOT NULL DEFAULT '{}'::jsonb,
    resultado       JSONB,
    error           TEXT,
    correlation_id  VARCHAR(64) NOT NULL,
    iniciado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finalizado_en   TIMESTAMPTZ,
    actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ejecuciones_estado ON ejecuciones_agente (estado);
CREATE INDEX IF NOT EXISTS idx_ejecuciones_flujo ON ejecuciones_agente (flujo_id);
CREATE INDEX IF NOT EXISTS idx_ejecuciones_correlation ON ejecuciones_agente (correlation_id);

-- ---------------------------------------------------------------
-- pasos_ejecucion
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pasos_ejecucion (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ejecucion_id  UUID NOT NULL REFERENCES ejecuciones_agente(id) ON DELETE CASCADE,
    orden         INTEGER NOT NULL CHECK (orden > 0),
    herramienta   VARCHAR(80) NOT NULL,
    razonamiento  TEXT,
    entrada       JSONB NOT NULL DEFAULT '{}'::jsonb,
    salida        JSONB,
    estado        VARCHAR(32) NOT NULL DEFAULT 'PENDIENTE'
                  CHECK (estado IN ('PENDIENTE','EN_EJECUCION','COMPLETADO','BLOQUEADO','FALLIDO')),
    error         TEXT,
    duracion_ms   INTEGER CHECK (duracion_ms IS NULL OR duracion_ms >= 0),
    creado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (ejecucion_id, orden)
);
CREATE INDEX IF NOT EXISTS idx_pasos_ejecucion ON pasos_ejecucion (ejecucion_id);

-- ---------------------------------------------------------------
-- aprobaciones_humanas
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aprobaciones_humanas (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ejecucion_id     UUID NOT NULL REFERENCES ejecuciones_agente(id) ON DELETE CASCADE,
    paso_id          UUID REFERENCES pasos_ejecucion(id) ON DELETE SET NULL,
    accion_propuesta JSONB NOT NULL,
    motivo           TEXT NOT NULL,
    monto_usd        NUMERIC(14,2) CHECK (monto_usd IS NULL OR monto_usd >= 0),
    estado           VARCHAR(16) NOT NULL DEFAULT 'PENDIENTE'
                     CHECK (estado IN ('PENDIENTE','APROBADA','RECHAZADA','EXPIRADA')),
    solicitado_en    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resuelto_en      TIMESTAMPTZ,
    resuelto_por     VARCHAR(120),
    comentario       TEXT,
    CHECK ((estado = 'PENDIENTE' AND resuelto_en IS NULL) OR (estado <> 'PENDIENTE'))
);
CREATE INDEX IF NOT EXISTS idx_aprobaciones_estado ON aprobaciones_humanas (estado);
CREATE INDEX IF NOT EXISTS idx_aprobaciones_ejecucion ON aprobaciones_humanas (ejecucion_id);

-- ---------------------------------------------------------------
-- auditoria_seguridad (append-only)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auditoria_seguridad (
    id              BIGSERIAL PRIMARY KEY,
    tipo_evento     VARCHAR(64) NOT NULL,
    severidad       VARCHAR(16) NOT NULL DEFAULT 'INFO'
                    CHECK (severidad IN ('INFO','WARN','ALTA','CRITICA')),
    actor           VARCHAR(120),
    ip_origen       INET,
    correlation_id  VARCHAR(64),
    detalle         JSONB NOT NULL DEFAULT '{}'::jsonb,
    creado_en       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auditoria_tipo ON auditoria_seguridad (tipo_evento);
CREATE INDEX IF NOT EXISTS idx_auditoria_creado ON auditoria_seguridad (creado_en DESC);

CREATE OR REPLACE FUNCTION fn_auditoria_inmutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'auditoria_seguridad es de solo anexado (append-only)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auditoria_inmutable ON auditoria_seguridad;
CREATE TRIGGER trg_auditoria_inmutable
    BEFORE UPDATE OR DELETE ON auditoria_seguridad
    FOR EACH ROW EXECUTE FUNCTION fn_auditoria_inmutable();

-- ---------------------------------------------------------------
-- catalogo_proveedores
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS catalogo_proveedores (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre              VARCHAR(120) NOT NULL,
    categoria           VARCHAR(60) NOT NULL,
    sku                 VARCHAR(40) NOT NULL UNIQUE,
    descripcion         TEXT NOT NULL,
    precio_unitario_usd NUMERIC(12,2) NOT NULL CHECK (precio_unitario_usd >= 0),
    plazo_entrega_dias  INTEGER NOT NULL CHECK (plazo_entrega_dias >= 0),
    calificacion        NUMERIC(2,1) NOT NULL CHECK (calificacion BETWEEN 0 AND 5),
    pais                VARCHAR(2) NOT NULL,
    activo              BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_proveedores_categoria ON catalogo_proveedores (categoria) WHERE activo;

-- ---------------------------------------------------------------
-- Datos semilla
-- ---------------------------------------------------------------
INSERT INTO flujos_definicion (nombre, descripcion, herramientas_permitidas, umbral_aprobacion_usd) VALUES
 ('cotizacion-comercial',
  'Consulta proveedores, valida presupuesto y emite una propuesta comercial.',
  ARRAY['consultar_proveedores','consultar_catalogo','validar_umbral_presupuestario','emitir_propuesta_comercial','notificar'],
  5000.00),
 ('compra-administrativa',
  'Gestiona solicitudes de compra internas con validación presupuestaria y notificación.',
  ARRAY['consultar_catalogo','validar_umbral_presupuestario','notificar'],
  2500.00)
ON CONFLICT (nombre) DO NOTHING;

INSERT INTO catalogo_proveedores (nombre, categoria, sku, descripcion, precio_unitario_usd, plazo_entrega_dias, calificacion, pais) VALUES
 ('TecnoSur SpA',        'hardware',    'HW-LAP-001', 'Laptop empresarial 14" 16GB RAM',        1150.00,  5, 4.6, 'CL'),
 ('TecnoSur SpA',        'hardware',    'HW-MON-002', 'Monitor 27" IPS 4K',                      420.00,  4, 4.6, 'CL'),
 ('Andes Cloud Partners','software',    'SW-LIC-010', 'Licencia anual suite colaborativa/usuario',  96.00,  1, 4.4, 'CL'),
 ('Andes Cloud Partners','software',    'SW-SEC-011', 'Licencia anual EDR/usuario',                 54.00,  1, 4.4, 'CL'),
 ('Pacific Office Supply','oficina',    'OF-SIL-020', 'Silla ergonómica de oficina',               230.00,  7, 4.1, 'US'),
 ('Pacific Office Supply','oficina',    'OF-ESC-021', 'Escritorio ajustable eléctrico',            480.00,  9, 4.1, 'US'),
 ('LogiExpress Ltda',    'logistica',  'LG-ENV-030', 'Envío nacional por pallet',                 180.00,  3, 4.2, 'CL'),
 ('ConsultaPro Group',   'servicios',  'SV-CON-040', 'Consultoría técnica (hora)',                 85.00,  2, 4.8, 'AR'),
 ('ConsultaPro Group',   'servicios',  'SV-AUD-041', 'Auditoría de seguridad aplicativa',        6500.00, 15, 4.8, 'AR'),
 ('Nube Austral SA',     'infraestructura','IN-SRV-050','Servidor rack 2U 64GB RAM',              4200.00, 12, 4.3, 'CL')
ON CONFLICT (sku) DO NOTHING;
