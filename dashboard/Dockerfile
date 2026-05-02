FROM oven/bun:1-alpine

WORKDIR /app
COPY server.ts .
COPY public/ public/

EXPOSE 3100
ENV DATA_DIR=/data \
    LOGS_DIR=/logs \
    DASHBOARD_PORT=3100

CMD ["bun", "run", "server.ts"]
