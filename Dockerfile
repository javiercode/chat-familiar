FROM node:18-alpine

# Instalar dependencias del sistema (SQLite viene incluido)
RUN apk add --no-cache sqlite

# Crear directorio de trabajo
WORKDIR /app

# Copiar archivos de configuración
COPY package*.json ./

# Instalar dependencias (cambiar npm ci por npm install)
RUN npm install --only=production

# Copiar código fuente
COPY server.js database.js init-db.sql ./
COPY ssl/ ./ssl/

# Crear directorio para la base de datos
RUN mkdir -p /app/data && chown -R node:node /app/data

# Crear usuario no root
USER node

# Exponer puerto
EXPOSE 8080

# Comando para iniciar la aplicación
CMD ["node", "server.js"]