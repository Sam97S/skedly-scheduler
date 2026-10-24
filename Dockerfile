FROM node:20-alpine

WORKDIR /app
COPY app/server.js /app/server.js

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "/app/server.js"]
