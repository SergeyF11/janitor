FROM node:20-alpine

WORKDIR /app

# Зависимости отдельным слоем для кэширования
COPY package*.json ./
RUN npm ci --only=production

COPY src/ ./src/

# Непривилегированный пользователь
RUN addgroup -S janitor && adduser -S janitor -G janitor
USER janitor

EXPOSE 3000
CMD ["node", "src/index.js"]
