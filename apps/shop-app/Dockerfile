FROM node:22-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

# パッケージマネージャは pnpm に揃える（package.json の packageManager）。
# pnpm-workspace.yaml が extensions/* を含むので、全体をコピーしてから入れる
COPY . .

RUN corepack enable && pnpm install --frozen-lockfile --prod=false && pnpm run build && pnpm prune --prod

CMD ["pnpm", "run", "docker-start"]
