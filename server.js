const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const url = require('url');
const Database = require('./database');

// Cargar certificados SSL
let sslOptions = null;
try {
    sslOptions = {
        key: fs.readFileSync('./ssl/chat-familiar.key'),
        cert: fs.readFileSync('./ssl/chat-familiar.crt')
    };
    console.log('✅ Certificados SSL cargados');
} catch (err) {
    console.log('⚠️ No se pudieron cargar certificados SSL, usando HTTP solamente');
}

class ChatServer {
    constructor(port = process.env.PORT || 8080) {
        this.port = port;
        this.server = null;
        this.wss = null;
        this.db = null;
        this.clients = new Map();
    }

    async start() {
        // Inicializar base de datos
        this.db = new Database();
        await this.db.initialize();

        // Manejador de peticiones HTTP/HTTPS
        const requestHandler = (req, res) => {
            const parsedUrl = url.parse(req.url, true);
            
            // Headers CORS
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Upgrade, Connection');
            
            if (req.method === 'OPTIONS') {
                res.writeHead(200);
                res.end();
                return;
            }
            
            if (parsedUrl.pathname === '/health') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString(), ssl: !!sslOptions }));
                return;
            }
            
            if (parsedUrl.pathname === '/api/historial') {
                this.handleHistoryRequest(req, res);
                return;
            }
            
            if (parsedUrl.pathname === '/api/usuarios') {
                this.handleUsersRequest(req, res);
                return;
            }
            
            res.writeHead(404);
            res.end('Not found');
        };

        // Crear servidor (HTTP o HTTPS)
        if (sslOptions) {
            this.server = https.createServer(sslOptions, requestHandler);
            console.log('✅ Servidor HTTPS creado');
        } else {
            this.server = http.createServer(requestHandler);
            console.log('✅ Servidor HTTP creado');
        }

        // Crear servidor WebSocket usando this.server
        this.wss = new WebSocket.Server({ server: this.server });
        
        this.wss.on('connection', (ws, req) => {
            this.handleConnection(ws, req);
        });

        // Heartbeat
        const interval = setInterval(() => {
            if (this.wss) {
                this.wss.clients.forEach((ws) => {
                    if (ws.isAlive === false) {
                        console.log(`[${ws.clientId}] 💀 Cliente muerto, terminando`);
                        return ws.terminate();
                    }
                    ws.isAlive = false;
                    ws.ping();
                });
            }
        }, 30000);
        
        this.wss.on('close', () => {
            clearInterval(interval);
        });

        // Iniciar servidor
        this.server.listen(this.port, '0.0.0.0', () => {
            const protocol = sslOptions ? 'wss' : 'ws';
            console.log(`🚀 Servidor chat corriendo en puerto ${this.port}`);
            console.log(`📡 WebSocket: ${protocol}://0.0.0.0:${this.port}`);
            console.log(`📊 API: http://0.0.0.0:${this.port}/api/historial`);
            console.log(`🔐 SSL activo: ${!!sslOptions}`);
        });
    }

    handleConnection(ws, req) {
        const clientId = Date.now();
        const ip = req.socket.remoteAddress;
        
        console.log(`[${clientId}] 👤 NUEVA CONEXIÓN desde ${ip}`);
        
        ws.clientId = clientId;
        ws.isAlive = true;
        ws.userInfo = null;
        
        ws.send(JSON.stringify({
            tipo: 'sistema',
            mensaje: '✅ Conectado al servidor. Por favor regístrate.',
            timestamp: new Date().toISOString()
        }));
        
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
                }
            } catch (error) {
                console.error(`[${ws.clientId}] Error:`, error);
                ws.send(JSON.stringify({ tipo: 'error', mensaje: 'Error procesando mensaje' }));
            }
        });
        
        ws.on('close', (code, reason) => {
            console.log(`[${ws.clientId}] 🔌 CONEXIÓN CERRADA - Código: ${code}`);
            if (ws.userInfo) {
                this.handleDisconnect(ws.userInfo);
            }
            this.clients.delete(ws);
        });
        
        ws.on('error', (error) => {
            console.error(`[${ws.clientId}] ❌ ERROR:`, error.message);
        });
        
        ws.on('pong', () => {
            ws.isAlive = true;
        });
    }

    async handleRegistro(ws, mensaje) {
        const { nombre, tipo_cliente = 'web' } = mensaje;
        
        if (!nombre || nombre.trim() === '') {
            ws.send(JSON.stringify({ tipo: 'error', mensaje: 'El nombre no puede estar vacío' }));
            return;
        }
        
        const nombreLimpio = nombre.trim();
        console.log(`[${ws.clientId}] 📝 Registrando: ${nombreLimpio}`);
        
        try {
            const usuario = await this.db.findOrCreateUser(
                nombreLimpio, tipo_cliente, ws._socket.remoteAddress, 'web'
            );
            
            ws.userInfo = {
                usuarioId: usuario.id,
                uuid: usuario.uuid,
                nombre: usuario.nombre,
                color: usuario.color,
                esNuevo: usuario.esNuevo
            };
            
            this.clients.set(ws, ws.userInfo);
            
            const mensajeBienvenida = usuario.esNuevo 
                ? `✅ ¡Bienvenid@ ${nombreLimpio} al chat familiar!`
                : `✅ ¡Bienvenid@ de vuelta ${nombreLimpio}!`;
            
            ws.send(JSON.stringify({
                tipo: 'sistema',
                mensaje: mensajeBienvenida,
                usuario: { id: usuario.uuid, nombre: usuario.nombre, color: usuario.color, esNuevo: usuario.esNuevo },
                timestamp: new Date().toISOString()
            }));
            
            const historial = await this.db.obtenerHistorial('Chat Familiar', 50);
            if (historial.length > 0) {
                ws.send(JSON.stringify({ tipo: 'historial', mensajes: historial.reverse(), timestamp: new Date().toISOString() }));
            }
            
            await this.broadcastActiveUsers();
            
        } catch (error) {
            console.error(`[${ws.clientId}] Error en registro:`, error);
            ws.send(JSON.stringify({ tipo: 'error', mensaje: 'Error interno al registrar usuario' }));
        }
    }

    async handleMensaje(ws, mensaje) {
        if (!ws.userInfo) {
            ws.send(JSON.stringify({ tipo: 'error', mensaje: 'Debes registrarte primero' }));
            return;
        }
        
        const { texto } = mensaje;
        if (!texto || texto.trim() === '') return;
        
        const textoLimpio = texto.trim();
        console.log(`[${ws.clientId}] 💬 ${ws.userInfo.nombre}: ${textoLimpio}`);
        
        try {
            await this.db.guardarMensaje(ws.userInfo.usuarioId, 'Chat Familiar', textoLimpio, 'texto');
            this.broadcast({
                tipo: 'mensaje',
                de: ws.userInfo.nombre,
                texto: textoLimpio,
                color: ws.userInfo.color,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('Error guardando mensaje:', error);
        }
    }

    async handleDisconnect(userInfo) {
        if (userInfo && userInfo.uuid) {
            await this.db.actualizarEstadoUsuario(userInfo.uuid, false);
            this.broadcast({ tipo: 'sistema', mensaje: `👋 ${userInfo.nombre} salió del chat`, timestamp: new Date().toISOString() });
            await this.broadcastActiveUsers();
        }
    }

    async handleHistoryRequest(req, res) {
        try {
            const mensajes = await this.db.obtenerHistorial('Chat Familiar', 100);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, mensajes: mensajes.reverse() }));
        } catch (error) {
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
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Error interno' }));
        }
    }

    async broadcastActiveUsers() {
        const usuarios = await this.db.obtenerUsuariosActivos();
        this.broadcast({ tipo: 'usuarios', lista: usuarios, timestamp: new Date().toISOString() });
    }

    broadcast(data, exclude = null) {
        const message = JSON.stringify(data);
        this.clients.forEach((info, clientWs) => {
            if (clientWs !== exclude && clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(message);
            }
        });
    }

    async stop() {
        if (this.db) await this.db.cerrar();
        if (this.wss) this.wss.close();
        if (this.server) this.server.close();
    }
}

const chatServer = new ChatServer();
chatServer.start().catch(console.error);

process.on('SIGTERM', () => chatServer.stop());
process.on('SIGINT', () => chatServer.stop());