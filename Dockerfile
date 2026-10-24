FROM node:22-alpine

WORKDIR /app
COPY app/ /app/app/
# Keep the mock suite in the image so CI tests the exact image it publishes.
COPY test/ /app/test/

ENV NODE_ENV=production
ENV PORT=8080
ENV DB_PATH=/data/skedly-scheduler.db
ENV MEDIA_DIR=/data/media
ENV MAX_MEDIA_BYTES=26214400
ENV WORKER_INTERVAL_MS=1000
ENV LEASE_MS=30000

RUN mkdir -p /data/media

EXPOSE 8080

CMD ["node", "--no-warnings", "/app/app/server.js"]
