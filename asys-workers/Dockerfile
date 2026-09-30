FROM asys-runtime
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-jsonschema \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/asys
COPY asys-inference/components/vendor/dcomp-component ./asys-inference/components/vendor/dcomp-component
COPY asys-inference/components/protocol/component ./asys-inference/components/protocol/component
COPY asys-inference/components/protocol/provider ./asys-inference/components/protocol/provider
COPY asys-workers/package.json asys-workers/package-lock.json asys-workers/.npmrc ./asys-workers/
WORKDIR /opt/asys/asys-workers
RUN npm ci --omit=dev
COPY asys-workers/src ./src
COPY asys-workers/gen ./gen
COPY asys-workers/extensions /opt/asys/asys-workers/extensions
COPY asys-workers/tools ./tools
COPY asys-workers/asys_swarm ./asys_swarm
COPY asys-workers/asys_worker.py ./asys_worker.py
COPY python/asys /opt/asys/python/asys
ENV NODE_ENV=production
ENV PYTHONPATH=/opt/asys/python:/opt/asys/asys-workers:/opt/asys/asys-runtime
USER node
ENTRYPOINT ["node", "/opt/asys/asys-workers/src/main.mjs"]
CMD []
HEALTHCHECK --interval=3s --timeout=2s --retries=3 CMD ["python3", "/opt/asys/asys-runtime/tools/asys-healthcheck", "/tmp/asys-runtime-health", "/tmp/asys-workers-health"]
