# Use a lightweight Node base image with build tools for native modules
FROM node:18-bullseye

# Install build deps for node-pty
RUN apt-get update && apt-get install -y --no-install-recommends \
  build-essential python3 git ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY package.json package.json
RUN npm install --production

COPY . .

EXPOSE 3000
CMD [ "npm", "start" ]
