FROM node:22-bookworm-slim

USER root
WORKDIR /app
COPY apps/share-service/src/server.mjs ./server.mjs
RUN mkdir -p /data && chown -R node:node /data /app
USER node
ENV NODE_ENV=production PORT=8090 SHARE_DATA_DIR=/data
EXPOSE 8090
HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8090/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
