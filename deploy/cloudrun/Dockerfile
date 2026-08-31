FROM node:20-slim
WORKDIR /app
COPY server.js package.json ./
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
