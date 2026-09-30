FROM asys-runtime
USER root
WORKDIR /opt/asys
COPY asys-inference/components/vendor/dcomp-component ./asys-inference/components/vendor/dcomp-component
COPY asys-bpmn/package.json asys-bpmn/package-lock.json asys-bpmn/.npmrc ./asys-bpmn/
WORKDIR /opt/asys/asys-bpmn
RUN npm ci --omit=dev
COPY asys-bpmn/src ./src
COPY asys-bpmn/gen ./gen
RUN install -d -o node -g node -m 0700 /var/lib/asys-bpmn
ENV NODE_ENV=production
USER node
ENTRYPOINT ["node", "/opt/asys/asys-bpmn/src/main.mjs"]
CMD []
HEALTHCHECK --interval=3s --timeout=2s --retries=3 CMD ["python3", "/opt/asys/asys-runtime/tools/asys-healthcheck", "/tmp/asys-bpmn-health"]
