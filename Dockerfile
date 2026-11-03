# syntax=docker/dockerfile:1
FROM oven/bun:1.3.14

WORKDIR /app
ARG TOONFLOW_WEB_BASE_PATH=""
ENV TOONFLOW_WEB_BASE_PATH=${TOONFLOW_WEB_BASE_PATH}

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY . .

# ACT: 保留工作区与依赖以兼容运行时动态加载；需要缩减镜像时再拆分构建阶段。
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile

RUN bun run build:server \
    && mkdir -p data/workspaces/myProject \
    && chown -R bun:bun data

ENV NODE_ENV=production
ENV TOONFLOW_DATA_DIR=/app/data
ENV TOONFLOW_HOST=0.0.0.0

USER bun
EXPOSE 3000

CMD ["bun", "build/server/index.js"]
