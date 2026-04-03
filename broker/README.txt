NanoMQ private broker (Render pserv or self-hosted)
==================================================

Files:
  Dockerfile              — NanoMQ image; build context = repo root (`COPY broker/...`)
  Dockerfile.broker-root  — same broker, context = broker/ only (Railway Root Directory = broker)
  nanomq.conf        — mTLS on 8883; TLS paths are flat under listeners.ssl (official docs)

Required PEM files for the broker container (mount under /etc/nanomq/certs/):
  root_ca.crt  — copy of data/ca/root-ca.crt (CA that signed broker.crt); underscore name in-container
  broker.crt   — NanoMQ server cert
  broker.key   — NanoMQ server private key (never commit; use Render Secret Files)

HOCON note: use keyfile / certfile / cacertfile directly on listeners.ssl. A nested
listeners.ssl.tls { } block is not read correctly on NanoMQ 0.24.x (paths become null).

Local smoke test (from repo root):
  docker build -f broker/Dockerfile -t proof-nanomq .
  docker run -d --name nanomq-test -p 8883:8883 \
    -v "$PWD/data/ca/root-ca.crt:/etc/nanomq/certs/root_ca.crt:ro" \
    -v "$PWD/broker/certs/broker.crt:/etc/nanomq/certs/broker.crt:ro" \
    -v "$PWD/broker/certs/broker.key:/etc/nanomq/certs/broker.key:ro" \
    proof-nanomq

  MQTT clients must match server cert CN (nanomq-broker): map nanomq-broker → 127.0.0.1
  (/etc/hosts or docker --add-host) when using TLS verification.

  Example publish (mosquitto client image):
  docker run --rm --network host --add-host=nanomq-broker:127.0.0.1 \
    -v "$PWD/data/ca/root-ca.crt:/ca/root-ca.crt:ro" \
    -v "$PWD/broker/certs/client.crt:/ca/client.crt:ro" \
    -v "$PWD/broker/certs/client.key:/ca/client.key:ro" \
    eclipse-mosquitto:2 mosquitto_pub -h nanomq-broker -p 8883 \
      --cafile /ca/root-ca.crt --cert /ca/client.crt --key /ca/client.key \
      -t proof.mqtt/test/active -m '{}' -V mqttv5

  TLS check:
  openssl s_client -connect 127.0.0.1:8883 -servername nanomq-broker \
    -CAfile data/ca/root-ca.crt -cert broker/certs/client.crt -key broker/certs/client.key

Render:
  - Private service: Secret Files → /etc/nanomq/certs/{root_ca.crt,broker.crt,broker.key}
  - Web service: MQTT_BROKER=nanomq-broker, MQTT_PORT=8883, MQTT_TLS_* for client mTLS

Railway:
  - See broker/RAILWAY.txt — broker/Dockerfile, RAILWAY_DOCKERFILE_PATH=broker/Dockerfile if needed,
    TCP proxy 8883, PEMs via NANOMQ_TLS_*. Template: broker/env.railway.example

Regenerating data/ca/root-ca.{key,crt} invalidates device certs in Mongo — re-provision devices.
