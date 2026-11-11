FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates gosu tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY deploy/container-entrypoint.sh /usr/local/bin/relay-entrypoint
RUN chmod 755 /usr/local/bin/relay-entrypoint
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data AUTO_CONNECT=true
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/relay-entrypoint"]
CMD ["node", "src/main.js"]
