FROM asys-runtime
USER root
WORKDIR /opt/asys
COPY asys-inference/components/vendor/dcomp-component ./asys-inference/components/vendor/dcomp-component
COPY asys-workers/gen ./asys-workers/gen
COPY asys-human-interface/package.json asys-human-interface/package-lock.json asys-human-interface/.npmrc ./asys-human-interface/
WORKDIR /opt/asys/asys-human-interface
RUN npm ci --omit=dev
COPY asys-human-interface/src ./src
RUN install -d -o node -g node -m 0700 /var/lib/asys-human
ENV NODE_ENV=production
USER node
ENTRYPOINT ["node", "/opt/asys/asys-human-interface/src/main.mjs"]
CMD []
HEALTHCHECK --interval=3s --timeout=2s --retries=3 CMD ["python3", "/opt/asys/asys-runtime/tools/asys-healthcheck", "/tmp/asys-human-interface-health"]
