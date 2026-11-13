# Thothsyn v2 后端镜像
# 目标：托管 Supabase（supabase.com 免费版）+ 任意支持 Docker 的 PaaS（Render / Railway / Fly）
#
# 本地试跑：
#   docker build -t thothsyn-server ./server
#   docker run -p 3000:3000 --env-file server/.env.prod thothsyn-server
#
# 说明：
#   - 管理页（web/）在构建期用 Node 编译成静态文件，由 FastAPI 托管在 /manage
#   - init_db 幂等；每次启动先建表/补列再起 uvicorn；DB 未就绪时重试
#   - 端口取环境变量 PORT（PaaS 注入），默认 3000

# ============ 阶段 1：构建管理页静态资源 ============
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build

# ============ 阶段 2：Python 运行环境 ============
FROM python:3.14-slim AS runtime
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH="/root/.local/bin:$PATH"

RUN pip install --no-cache-dir uv

WORKDIR /app

# 先装 Python 依赖（利用缓存层）
COPY pyproject.toml uv.lock ./
RUN uv sync --no-dev

# 再拷源码
COPY . .

# 拷入阶段 1 构建好的管理页
COPY --from=web /web/dist ./web/dist

EXPOSE 3000

CMD ["sh", "-c", "for i in $(seq 1 30); do uv run python -m init_db && break; echo '[init_db] DB 未就绪，重试 $i/30'; sleep 3; done; uv run uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-3000}"]
