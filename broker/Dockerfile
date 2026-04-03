# NanoMQ — build context must be the repository root (same as former Dockerfile.nanomq).
# docker build -f broker/Dockerfile -t proof-nanomq .
#
# Railway: Root Directory empty; set dockerfilePath to broker/Dockerfile (repo root has another Dockerfile for Node).
# If Root Directory is broker/ only, use broker/Dockerfile.broker-root instead.
FROM emqx/nanomq:latest-slim

COPY broker/nanomq.conf /etc/nanomq.conf
COPY broker/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 8883

ENTRYPOINT ["/docker-entrypoint.sh"]
