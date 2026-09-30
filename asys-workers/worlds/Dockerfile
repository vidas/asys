FROM asys-runtime
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-jsonschema \
 && rm -rf /var/lib/apt/lists/*
COPY asys-workers/asys_swarm /opt/asys/asys-workers/asys_swarm
COPY asys-workers/worlds/common.py asys-workers/worlds/__init__.py /opt/asys/worlds/
ENV PYTHONPATH=/opt/asys:/opt/asys/asys-workers:/opt/asys/asys-runtime
ENV ASYS_WORLD_ROOT=/var/lib/asys-world
ENV ASYS_WORLD_HEALTH_FILE=/tmp/asys-world-health
USER node
ENTRYPOINT []
CMD []
HEALTHCHECK --interval=3s --timeout=2s --retries=3 CMD ["python3", "/opt/asys/asys-runtime/tools/asys-healthcheck", "/tmp/asys-world-health"]
