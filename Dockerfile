FROM node:20-alpine

WORKDIR /app

# Copia manifestos de dependência
COPY package*.json ./

# Instala apenas dependências de produção
RUN npm ci --only=production

# Copia código da aplicação
COPY src/ ./src/
COPY static/ ./static/
COPY scripts/ ./scripts/

# Cria pasta de dados para volume
RUN mkdir -p /app/data

EXPOSE 8000

ENV PORT=8000 \
    NODE_ENV=production

CMD ["node", "src/server.js"]
