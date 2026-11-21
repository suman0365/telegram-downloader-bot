FROM node:20-slim

# telegram-bot-api needs curl + certs to download, and the binary needs no
# extra runtime deps. Install once, clean up apt lists to keep the image small.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Try to install the official Local Bot API server binary (tdlib).
# If GitHub is unreachable at build time this must NOT fail the build:
# the app still runs in hosted mode (20 MB getFile limit) and the README
# explains how to run the local server separately with docker-compose.
# Pin a known release; `latest/download` is not used on purpose.
RUN curl -fsSL -o /usr/local/bin/telegram-bot-api \
      https://github.com/tdlib/telegram-bot-api/releases/download/v8.0/telegram-bot-api \
  && chmod +x /usr/local/bin/telegram-bot-api \
  && echo "telegram-bot-api binary installed" \
  || echo "WARNING: telegram-bot-api binary NOT downloaded — local mode unavailable in this image, hosted mode only. See README."

RUN mkdir -p /var/lib/telegram-bot-api /tmp/telegram-bot-api-tmp
COPY start.sh ./start.sh
RUN chmod +x ./start.sh

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

CMD ["./start.sh"]
