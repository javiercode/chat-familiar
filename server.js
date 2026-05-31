const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const Database = require('./database');

class ChatServer {
    constructor(port = process.env.PORT || 8080) {
        this.port = port;
        this.server = null;
        this.wss = null;
        this.db = null;
        this.clients = new Map(); // key: ws, value: { usuarioId, uuid, nombre, color }
    }

    async start() {
        // Inicializar base de datos
        this.db = new Database();
        await this.db.initialize();

        // Crear servidor HTTP
        this.server = http.createServer((req, res) => {
            const parsedUrl = url.parse(req.url, true);
            
            // Endpoint de salud
            if (parsedUrl.pathname === '/health') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
                return;
            }
            
            // Endpoint para obtener historial
            if (parsedUrl.pathname === '/api/historial') {
                this.handleHistoryRequest(req, res);
                return;
            }
            
            // Endpoint para usuarios activos
            if (parsedUrl.pathname === '/api/usuarios') {
                this.handleUsersRequest(req, res);
                return;
            }
            
            res.writeHead(404);
            res.end('Not found');
        });

        // Crear servidor WebSocket
        this.wss = new WebSocket.Server({ server: this.server });
        
        this.wss.on('connection', (ws, req) => {
            this.handleConnection(ws, req);
        });

        // Heartbeat para detectar conexiones muertas
        const interval = setInterval(() => {
            this.wss.clients.forEach((ws) => {
                if (ws.isAlive === false) {
                    console.log(`[${ws.clientId}] 💀 Cliente muerto, terminando conexión`);
                    return ws.terminate();
                }
                ws.isAlive = false;
                ws.ping();
            });
        }, 30000);
        
        this.wss.on('close', () => {
            clearInterval(interval);
        });

        // Iniciar servidor
        this.server.listen(this.port, '0.0.0.0', () => {
            console.log(`🚀 Servidor chat corriendo en puerto ${this.port}`);
            console.log(`📡 WebSocket: ws://0.0.0.0:${this.port}`);
            console.log(`📊 API: http://0.0.0.0:${this.port}/api/historial`);
        });
    }

    handleConnection(ws, req) {
        const clientId = Date.now();
        const ip = req.socket.remoteAddress;
        
        console.log(`[${clientId}] 👤 NUEVA CONEXIÓN desde ${ip}`);
        
        // Agregar propiedades al WebSocket
        ws.clientId = clientId;
        ws.isAlive = true;
        ws.userInfo = null;
        
        // Enviar mensaje de bienvenida inmediato
        ws.send(JSON.stringify({
            tipo: 'sistema',
            mensaje: '✅ Conectado al servidor. Por favor regístrate.',
            timestamp: new Date().toISOString()
        }));
        
        // Manejador de mensajes
        ws.on('message', async (data) => {
            try {
                const msgStr = data.toString();
                console.log(`[${ws.clientId}] 📨 Mensaje: ${msgStr.substring(0, 150)}`);
                const mensaje = JSON.parse(msgStr);
                
                switch (mensaje.tipo) {
                    case 'registro':
                        await this.handleRegistro(ws, mensaje);
                        break;
                        
                    case 'mensaje':
                        await this.handleMensaje(ws, mensaje);
                        break;
                        
                    case 'ping':
                        ws.send(JSON.stringify({ tipo: 'pong', timestamp: Date.now() }));
                        break;
                        
                    default:
                        console.log(`[${ws.clientId}] Tipo desconocido: ${mensaje.tipo}`);
                        ws.send(JSON.stringify({
                            tipo: 'sistema',
                            mensaje: `Tipo no reconocido: ${mensaje.tipo}`
                        }));
                }
            } catch (error) {
                console.error(`[${ws.clientId}] Error procesando mensaje:`, error);
                ws.send(JSON.stringify({
                    tipo: 'error',
                    mensaje: 'Error procesando mensaje: ' + error.message
                }));
            }
        });
        
        // Manejador de cierre
        ws.on('close', (code, reason) => {
            console.log(`[${ws.clientId}] 🔌 CONEXIÓN CERRADA - Código: ${code}, Razón: ${reason || 'No especificada'}`);
            if (ws.userInfo) {
                console.log(`[${ws.clientId}] Usuario ${ws.userInfo.nombre} se desconectó`);
                this.handleDisconnect(ws.userInfo);
            }
            this.clients.delete(ws);
        });
        
        // Manejador de errores
        ws.on('error', (error) => {
            console.error(`[${ws.clientId}] ❌ ERROR:`, error.message);
        });
        
        // Manejador de pong para heartbeat
        ws.on('pong', () => {
            ws.isAlive = true;
        });
    }

    async handleRegistro(ws, mensaje) {
        const { nombre, tipo_cliente = 'web' } = mensaje;
        
        if (!nombre || nombre.trim() === '') {
            ws.send(JSON.stringify({
                tipo: 'error',
                mensaje: 'El nombre no puede estar vacío'
            }));
            return;
        }
        
        const nombreLimpio = nombre.trim();
        console.log(`[${ws.clientId}] 📝 Procesando registro para: ${nombreLimpio}`);
        
        try {
            // Buscar o crear usuario usando la nueva función
            const usuario = await this.db.findOrCreateUser(
                nombreLimpio,
                tipo_cliente,
                ws._socket.remoteAddress,
                'web'
            );
            
            // Guardar información del usuario en el WebSocket
            ws.userInfo = {
                usuarioId: usuario.id,
                uuid: usuario.uuid,
                nombre: usuario.nombre,
                color: usuario.color,
                esNuevo: usuario.esNuevo
            };
            
            // Guardar en el Map de clientes
            this.clients.set(ws, ws.userInfo);
            
            // Mensaje de bienvenida personalizado
            const mensajeBienvenida = usuario.esNuevo 
                ? `✅ ¡Bienvenid@ ${nombreLimpio} al chat familiar!`
                : `✅ ¡Bienvenid@ de vuelta ${nombreLimpio}!`;
            
            ws.send(JSON.stringify({
                tipo: 'sistema',
                mensaje: mensajeBienvenida,
                usuario: {
                    id: usuario.uuid,
                    nombre: usuario.nombre,
                    color: usuario.color,
                    esNuevo: usuario.esNuevo
                },
                timestamp: new Date().toISOString()
            }));
            
            console.log(`[${ws.clientId}] ✅ Usuario procesado: ${nombreLimpio} (${usuario.esNuevo ? 'nuevo' : 'existente'})`);
            
            // Enviar historial de mensajes
            const historial = await this.db.obtenerHistorial('Chat Familiar', 50);
            if (historial.length > 0) {
                ws.send(JSON.stringify({
                    tipo: 'historial',
                    mensajes: historial.reverse(),
                    timestamp: new Date().toISOString()
                }));
            }
            
            // Anunciar a todos solo si es nuevo o ha pasado más de 5 minutos
            const ahora = new Date();
            let debeAnunciar = usuario.esNuevo;
            
            if (!debeAnunciar) {
                const ultimaConexion = await this.db.get(
                    "SELECT ultima_conexion FROM usuarios WHERE id = ?",
                    [usuario.id]
                );
                if (ultimaConexion) {
                    const tiempoDesdeUltima = ahora - new Date(ultimaConexion.ultima_conexion);
                    debeAnunciar = tiempoDesdeUltima > 5 * 60 * 1000; // 5 minutos
                }
            }
            
            if (debeAnunciar) {
                this.broadcast({
                    tipo: 'sistema',
                    mensaje: `✨ ${nombreLimpio} se unió al chat`,
                    timestamp: new Date().toISOString()
                }, ws);
            }
            
            // Actualizar lista de usuarios activos
            await this.broadcastActiveUsers();
            
        } catch (error) {
            console.error(`[${ws.clientId}] Error en registro:`, error);
            ws.send(JSON.stringify({
                tipo: 'error',
                mensaje: 'Error interno al registrar usuario'
            }));
        }
    }

    async handleMensaje(ws, mensaje) {
        if (!ws.userInfo) {
            ws.send(JSON.stringify({
                tipo: 'error',
                mensaje: 'Debes registrarte primero'
            }));
            return;
        }
        
        const { texto } = mensaje;
        if (!texto || texto.trim() === '') {
            return;
        }
        
        const textoLimpio = texto.trim();
        console.log(`[${ws.clientId}] 💬 Mensaje de ${ws.userInfo.nombre}: ${textoLimpio}`);
        
        try {
            // Guardar en base de datos
            await this.db.guardarMensaje(
                ws.userInfo.usuarioId,
                'Chat Familiar',
                textoLimpio,
                'texto'
            );
            
            // Transmitir a todos los clientes
            this.broadcast({
                tipo: 'mensaje',
                de: ws.userInfo.nombre,
                texto: textoLimpio,
                color: ws.userInfo.color,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error(`[${ws.clientId}] Error guardando mensaje:`, error);
            ws.send(JSON.stringify({
                tipo: 'error',
                mensaje: 'Error al guardar mensaje'
            }));
        }
    }

    async handleDisconnect(userInfo) {
        if (userInfo && userInfo.uuid) {
            try {
                await this.db.actualizarEstadoUsuario(userInfo.uuid, false);
                
                this.broadcast({
                    tipo: 'sistema',
                    mensaje: `👋 ${userInfo.nombre} salió del chat`,
                    timestamp: new Date().toISOString()
                });
                
                await this.broadcastActiveUsers();
            } catch (error) {
                console.error('Error en disconnect:', error);
            }
        }
    }

    async handleHistoryRequest(req, res) {
        try {
            const mensajes = await this.db.obtenerHistorial('Chat Familiar', 100);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, mensajes: mensajes.reverse() }));
        } catch (error) {
            console.error('Error obteniendo historial:', error);
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Error interno' }));
        }
    }

    async handleUsersRequest(req, res) {
        try {
            const usuarios = await this.db.obtenerUsuariosActivos();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, usuarios }));
        } catch (error) {
            console.error('Error obteniendo usuarios:', error);
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Error interno' }));
        }
    }

    async broadcastActiveUsers() {
        try {
            const usuarios = await this.db.obtenerUsuariosActivos();
            this.broadcast({
                tipo: 'usuarios',
                lista: usuarios,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('Error broadcastActiveUsers:', error);
        }
    }

    broadcast(data, exclude = null) {
        const message = JSON.stringify(data);
        let count = 0;
        
        this.clients.forEach((info, clientWs) => {
            if (clientWs !== exclude && clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(message);
                count++;
            }
        });
        
        if (count > 0) {
            console.log(`📡 Broadcast a ${count} clientes: ${data.tipo}`);
        }
    }

    async stop() {
        console.log('🛑 Cerrando servidor...');
        if (this.db) {
            await this.db.cerrar();
        }
        if (this.wss) {
            this.wss.close();
        }
        if (this.server) {
            this.server.close();
        }
    }
}

// Iniciar servidor
const chatServer = new ChatServer();
chatServer.start().catch(console.error);

// Manejar cierre graceful
process.on('SIGTERM', () => {
    console.log('SIGTERM recibido, cerrando servidor...');
    chatServer.stop().then(() => process.exit(0));
});

process.on('SIGINT', () => {
    console.log('SIGINT recibido, cerrando servidor...');
    chatServer.stop().then(() => process.exit(0));
});