# Multi-stage: copy the official Local Bot API server binary (tdlib) from
# the aiogram/telegram-bot-api image — the same image the README uses for
# local runs. The old approach downloaded a binary from
# github.com/tdlib/telegram-bot-api/releases, but that repo publishes no
# releases, so the URL 404'd and the image silently had no binary.
#
# The aiogram binary is built for Alpine (musl), so this image must also
# be Alpine-based (node:20-alpine); it cannot run on Debian-slim (glibc).
FROM aiogram/telegram-bot-api:latest AS botapi

FROM node:20-alpine

# Runtime deps for the Bot API server binary (openssl, libstdc++) plus
# curl + certs. Install once; --no-cache keeps the image small.
RUN apk add --no-cache curl ca-certificates openssl libstdc++

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Local Bot API server binary, copied from the aiogram image into the
# location start.sh expects. Fail the build if it is missing or not
# executable — local mode (files over 20 MB, up to 4 GB) depends on it.
COPY --from=botapi /usr/local/bin/telegram-bot-api /usr/local/bin/telegram-bot-api
RUN chmod +x /usr/local/bin/telegram-bot-api \
  && test -x /usr/local/bin/telegram-bot-api

RUN mkdir -p /var/lib/telegram-bot-api /tmp/telegram-bot-api-tmp

COPY start.sh ./start.sh
RUN chmod +x ./start.sh

ENV NODE_ENV=production
ENV PORT=10000

EXPOSE 10000

CMD ["./start.sh"]
