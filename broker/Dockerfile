# Option B only: use when Railway "Root Directory" is `broker/`.
# Option A (recommended): leave Root Directory empty and use broker/Dockerfile.nanomq from repo root.
FROM emqx/nanomq:latest-slim

COPY nanomq.conf /etc/nanomq.conf
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 8883

ENTRYPOINT ["/docker-entrypoint.sh"]
