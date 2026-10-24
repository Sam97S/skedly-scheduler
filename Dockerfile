FROM node:22-alpine

WORKDIR /app
COPY app/server.js /app/server.js

ENV NODE_ENV=production
ENV PORT=8080
ENV DB_PATH=/data/skedly-scheduler.db
ENV WORKER_INTERVAL_MS=1000
ENV LEASE_MS=30000

RUN mkdir -p /data

EXPOSE 8080

CMD ["node", "--no-warnings", "/app/server.js"]
