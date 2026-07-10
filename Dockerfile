FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install

EXPOSE 10000

CMD ["npx", "omniroute", "serve"]
