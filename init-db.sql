-- Habilitar claves foráneas
PRAGMA foreign_keys = ON;

-- Tabla de usuarios
CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    nombre TEXT NOT NULL,
    tipo_cliente TEXT CHECK(tipo_cliente IN ('web', 'flutter', 'desconocido')) DEFAULT 'desconocido',
    ultima_conexion DATETIME DEFAULT CURRENT_TIMESTAMP,
    primera_conexion DATETIME DEFAULT CURRENT_TIMESTAMP,
    activo BOOLEAN DEFAULT 1,
    color_asignado TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tabla de conversaciones (chats)
CREATE TABLE IF NOT EXISTS conversaciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    nombre TEXT NOT NULL,
    descripcion TEXT,
    es_grupal BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tabla de participantes (relación usuarios-conversaciones)
CREATE TABLE IF NOT EXISTS participantes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    conversacion_id INTEGER NOT NULL,
    ultimo_leido DATETIME DEFAULT CURRENT_TIMESTAMP,
    se_fue BOOLEAN DEFAULT 0,
    fecha_entrada DATETIME DEFAULT CURRENT_TIMESTAMP,
    fecha_salida DATETIME,
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
    FOREIGN KEY (conversacion_id) REFERENCES conversaciones(id) ON DELETE CASCADE,
    UNIQUE(usuario_id, conversacion_id)
);

-- Tabla de mensajes
CREATE TABLE IF NOT EXISTS mensajes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    conversacion_id INTEGER NOT NULL,
    usuario_id INTEGER NOT NULL,
    mensaje TEXT NOT NULL,
    tipo TEXT CHECK(tipo IN ('texto', 'sistema', 'notificacion')) DEFAULT 'texto',
    leido BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversacion_id) REFERENCES conversaciones(id) ON DELETE CASCADE,
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
);

-- Tabla para sesiones activas (WebSocket)
CREATE TABLE IF NOT EXISTS sesiones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    session_id TEXT UNIQUE NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    conectado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
    ultimo_ping DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
);

-- Índices para optimizar búsquedas
CREATE INDEX idx_mensajes_conversacion ON mensajes(conversacion_id, created_at DESC);
CREATE INDEX idx_mensajes_usuario ON mensajes(usuario_id, created_at DESC);
CREATE INDEX idx_participantes_usuario ON participantes(usuario_id);
CREATE INDEX idx_participantes_conversacion ON participantes(conversacion_id);
CREATE INDEX idx_sesiones_usuario ON sesiones(usuario_id);
CREATE INDEX idx_sesiones_activas ON sesiones(conectado_en) WHERE julianday('now') - julianday(conectado_en) < 1;
CREATE INDEX idx_usuarios_activos ON usuarios(activo);

-- Insertar conversación principal (familiar)
INSERT OR IGNORE INTO conversaciones (uuid, nombre, descripcion, es_grupal) 
VALUES ('fam-main-001', 'Chat Familiar', 'Conversación principal de la familia', 1);

-- Vista para mensajes recientes (últimos 100 por conversación)
CREATE VIEW IF NOT EXISTS vista_mensajes_recientes AS
SELECT 
    m.id,
    m.uuid,
    m.mensaje,
    m.tipo,
    m.created_at,
    u.nombre as usuario_nombre,
    u.color_asignado,
    c.nombre as conversacion_nombre
FROM mensajes m
JOIN usuarios u ON m.usuario_id = u.id
JOIN conversaciones c ON m.conversacion_id = c.id
WHERE m.created_at > datetime('now', '-7 days')
ORDER BY m.created_at DESC
LIMIT 100;

-- Trigger para actualizar updated_at
CREATE TRIGGER IF NOT EXISTS update_usuarios_timestamp 
AFTER UPDATE ON usuarios
BEGIN
    UPDATE usuarios SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_conversaciones_timestamp 
AFTER UPDATE ON conversaciones
BEGIN
    UPDATE conversaciones SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;