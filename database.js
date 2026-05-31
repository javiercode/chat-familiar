const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

class Database {
    constructor(dbPath = process.env.DB_PATH || './data/chat.db') {
        this.dbPath = dbPath;
        this.db = null;
    }

    async initialize() {
        // Asegurar que el directorio existe
        const dbDir = path.dirname(this.dbPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    console.error('❌ Error conectando a SQLite:', err);
                    reject(err);
                } else {
                    console.log('✅ Conectado a SQLite:', this.dbPath);
                    this.initTables().then(resolve).catch(reject);
                }
            });
        });
    }

    async initTables() {
        const tables = [
            `CREATE TABLE IF NOT EXISTS usuarios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uuid TEXT UNIQUE NOT NULL,
                nombre TEXT NOT NULL,
                tipo_cliente TEXT DEFAULT 'desconocido',
                ultima_conexion DATETIME DEFAULT CURRENT_TIMESTAMP,
                primera_conexion DATETIME DEFAULT CURRENT_TIMESTAMP,
                activo BOOLEAN DEFAULT 1,
                color_asignado TEXT DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            
            `CREATE TABLE IF NOT EXISTS conversaciones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uuid TEXT UNIQUE NOT NULL,
                nombre TEXT NOT NULL,
                descripcion TEXT,
                es_grupal BOOLEAN DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            
            `CREATE TABLE IF NOT EXISTS participantes (
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
            )`,
            
            `CREATE TABLE IF NOT EXISTS mensajes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uuid TEXT UNIQUE NOT NULL,
                conversacion_id INTEGER NOT NULL,
                usuario_id INTEGER NOT NULL,
                mensaje TEXT NOT NULL,
                tipo TEXT DEFAULT 'texto',
                leido BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (conversacion_id) REFERENCES conversaciones(id) ON DELETE CASCADE,
                FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
            )`,
            
            `CREATE TABLE IF NOT EXISTS sesiones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                usuario_id INTEGER NOT NULL,
                session_id TEXT UNIQUE NOT NULL,
                ip_address TEXT,
                user_agent TEXT,
                conectado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
                ultimo_ping DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
            )`
        ];

        // Ejecutar creación de tablas
        for (const sql of tables) {
            try {
                await this.run(sql);
            } catch (err) {
                console.error('Error creando tabla:', err);
                throw err;
            }
        }

        // Insertar conversación principal
        try {
            await this.run(`
                INSERT OR IGNORE INTO conversaciones (uuid, nombre, descripcion, es_grupal) 
                VALUES ('fam-main-001', 'Chat Familiar', 'Conversación principal de la familia', 1)
            `);
        } catch (err) {
            console.error('Error insertando conversación:', err);
        }

        // Crear triggers
        const triggers = [
            `CREATE TRIGGER IF NOT EXISTS update_usuarios_timestamp 
            AFTER UPDATE ON usuarios
            BEGIN
                UPDATE usuarios SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
            END`,
            
            `CREATE TRIGGER IF NOT EXISTS update_conversaciones_timestamp 
            AFTER UPDATE ON conversaciones
            BEGIN
                UPDATE conversaciones SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
            END`
        ];

        for (const sql of triggers) {
            try {
                await this.run(sql);
            } catch (err) {
                if (!err.message.includes('already exists')) {
                    console.warn('Trigger warning:', err.message);
                }
            }
        }

        // Verificar índices existentes
        const existingIndexes = await this.all(`
            SELECT name FROM sqlite_master 
            WHERE type='index' AND name IN (
                'idx_mensajes_conversacion',
                'idx_mensajes_usuario', 
                'idx_participantes_usuario',
                'idx_participantes_conversacion',
                'idx_usuarios_activos'
            )
        `);
        
        const existingIndexNames = existingIndexes.map(i => i.name);
        
        const indexMap = {
            'idx_mensajes_conversacion': 'CREATE INDEX idx_mensajes_conversacion ON mensajes(conversacion_id, created_at DESC)',
            'idx_mensajes_usuario': 'CREATE INDEX idx_mensajes_usuario ON mensajes(usuario_id, created_at DESC)',
            'idx_participantes_usuario': 'CREATE INDEX idx_participantes_usuario ON participantes(usuario_id)',
            'idx_participantes_conversacion': 'CREATE INDEX idx_participantes_conversacion ON participantes(conversacion_id)',
            'idx_usuarios_activos': 'CREATE INDEX idx_usuarios_activos ON usuarios(activo)'
        };
        
        for (const [indexName, createSQL] of Object.entries(indexMap)) {
            if (!existingIndexNames.includes(indexName)) {
                try {
                    await this.run(createSQL);
                    console.log(`✅ Índice creado: ${indexName}`);
                } catch (err) {
                    console.warn(`⚠️ No se pudo crear índice ${indexName}:`, err.message);
                }
            } else {
                console.log(`📌 Índice ya existe: ${indexName}`);
            }
        }

        console.log('✅ Base de datos inicializada correctamente');
    }

    run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                if (err) reject(err);
                else resolve({ lastID: this.lastID, changes: this.changes });
            });
        });
    }

    get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });
    }

    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    // Función principal para buscar o crear usuario
    async findOrCreateUser(nombre, tipoCliente = 'web', ip = null, userAgent = null) {
        // Buscar usuario existente por nombre (case insensitive)
        const usuarioExistente = await this.get(
            "SELECT * FROM usuarios WHERE LOWER(nombre) = LOWER(?)",
            [nombre]
        );
        
        if (usuarioExistente) {
            // Usuario existe, actualizar su información
            console.log(`📝 Usuario existente encontrado: ${nombre} (ID: ${usuarioExistente.id})`);
            
            await this.run(
                `UPDATE usuarios 
                 SET tipo_cliente = ?, 
                     ultima_conexion = CURRENT_TIMESTAMP,
                     activo = 1,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [tipoCliente, usuarioExistente.id]
            );
            
            // Registrar nueva sesión
            if (ip) {
                const sessionId = uuidv4();
                await this.run(
                    `INSERT INTO sesiones (usuario_id, session_id, ip_address, user_agent)
                     VALUES (?, ?, ?, ?)`,
                    [usuarioExistente.id, sessionId, ip, userAgent]
                );
            }
            
            return {
                id: usuarioExistente.id,
                uuid: usuarioExistente.uuid,
                nombre: usuarioExistente.nombre,
                color: usuarioExistente.color_asignado,
                esNuevo: false
            };
        } else {
            // Usuario nuevo, crear registro
            console.log(`✨ Nuevo usuario: ${nombre}`);
            const uuid = uuidv4();
            const colores = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD'];
            const colorAleatorio = colores[Math.floor(Math.random() * colores.length)];
            
            const result = await this.run(
                `INSERT INTO usuarios (uuid, nombre, tipo_cliente, color_asignado, activo, ultima_conexion, primera_conexion)
                 VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                [uuid, nombre, tipoCliente, colorAleatorio]
            );
            
            const usuarioId = result.lastID;
            
            // Agregar a la conversación familiar
            const conversacion = await this.get(
                "SELECT id FROM conversaciones WHERE nombre = 'Chat Familiar' LIMIT 1"
            );
            
            if (conversacion) {
                await this.run(
                    `INSERT OR IGNORE INTO participantes (usuario_id, conversacion_id)
                     VALUES (?, ?)`,
                    [usuarioId, conversacion.id]
                );
            }
            
            // Registrar sesión
            if (ip) {
                const sessionId = uuidv4();
                await this.run(
                    `INSERT INTO sesiones (usuario_id, session_id, ip_address, user_agent)
                     VALUES (?, ?, ?, ?)`,
                    [usuarioId, sessionId, ip, userAgent]
                );
            }
            
            return {
                id: usuarioId,
                uuid: uuid,
                nombre: nombre,
                color: colorAleatorio,
                esNuevo: true
            };
        }
    }

    async guardarMensaje(usuarioId, conversacionNombre, mensaje, tipo = 'texto') {
        const conversacion = await this.get(
            "SELECT id FROM conversaciones WHERE nombre = ? LIMIT 1",
            [conversacionNombre]
        );
        
        if (!conversacion) {
            throw new Error('Conversación no encontrada');
        }
        
        const uuid = uuidv4();
        await this.run(
            `INSERT INTO mensajes (uuid, conversacion_id, usuario_id, mensaje, tipo)
             VALUES (?, ?, ?, ?, ?)`,
            [uuid, conversacion.id, usuarioId, mensaje, tipo]
        );
        
        await this.run(
            "UPDATE usuarios SET ultima_conexion = CURRENT_TIMESTAMP WHERE id = ?",
            [usuarioId]
        );
        
        return await this.get(
            `SELECT m.*, u.nombre as usuario_nombre, u.color_asignado
             FROM mensajes m
             JOIN usuarios u ON m.usuario_id = u.id
             WHERE m.uuid = ?`,
            [uuid]
        );
    }

    async obtenerHistorial(conversacionNombre = 'Chat Familiar', limite = 50) {
        const conversacion = await this.get(
            "SELECT id FROM conversaciones WHERE nombre = ? LIMIT 1",
            [conversacionNombre]
        );
        
        if (!conversacion) return [];
        
        return await this.all(
            `SELECT 
                m.uuid,
                m.mensaje as texto,
                m.tipo,
                m.created_at as timestamp,
                u.nombre as de,
                u.color_asignado,
                u.id as usuario_id
             FROM mensajes m
             JOIN usuarios u ON m.usuario_id = u.id
             WHERE m.conversacion_id = ? AND m.tipo = 'texto'
             ORDER BY m.created_at DESC
             LIMIT ?`,
            [conversacion.id, limite]
        );
    }

    async actualizarEstadoUsuario(uuid, activo) {
        await this.run(
            "UPDATE usuarios SET activo = ?, ultima_conexion = CURRENT_TIMESTAMP WHERE uuid = ?",
            [activo ? 1 : 0, uuid]
        );
    }

    async obtenerUsuariosActivos() {
        return await this.all(
            `SELECT uuid, nombre, color_asignado, tipo_cliente, ultima_conexion
             FROM usuarios
             WHERE activo = 1 AND julianday('now') - julianday(ultima_conexion) < 0.1
             ORDER BY nombre`
        );
    }

    async cerrar() {
        if (this.db) {
            await this.db.close();
            console.log('🔒 Base de datos cerrada');
        }
    }
}

module.exports = Database;