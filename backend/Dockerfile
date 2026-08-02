FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && apk add --no-cache putty su-exec

COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# /app/data is where the db_data volume mounts. chown here covers a *fresh*
# volume (Docker seeds a new named volume from the image, ownership included);
# the entrypoint repeats it at runtime for volumes that already exist from a
# root-era deployment, where the mount masks whatever the image says.
#
# There is deliberately no `USER node` line: the entrypoint has to start as root
# to be able to fix that ownership, and drops to node (uid 1000) with su-exec
# before exec'ing the CMD. The Node process itself never runs as root.
RUN mkdir -p /app/data \
 && chown -R node:node /app/data \
 && sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
 && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
