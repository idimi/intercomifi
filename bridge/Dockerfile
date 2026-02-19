FROM node:20-slim

WORKDIR /app

# Install build dependencies for native modules (required for hyperswarm/udx-native)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY server.js .

RUN npm init -y && \
    npm install hyperswarm hypercore-crypto ws

EXPOSE 8080

CMD ["node", "server.js"]
