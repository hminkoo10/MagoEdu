# 마고에듀 통합 클라우드 서버
#   docker build -t magoedu-cloud server
#   docker run -d -p 8470:8470 -v magoedu-data:/data --name magoedu-cloud magoedu-cloud
FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/hminkoo10/MagoEdu" \
      org.opencontainers.image.description="마고에듀 통합 클라우드 서버 - 구현민 개발"

WORKDIR /app
COPY package.json catalog.default.json ./
COPY src ./src
COPY public ./public
# 웹 화면 (Server image 워크플로가 launcher/src/renderer 를 넣어 줘요. 비어 있으면 내려받기 안내 페이지만)
COPY web ./web

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8470

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8470

CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
