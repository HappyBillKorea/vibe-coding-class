# Node 22: better-sqlite3가 미리 빌드된 바이너리를 제공하는 버전이라
# 빌드 때 C++ 컴파일(python3/make/g++ 설치 포함)이 필요 없습니다.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# package*.json만 먼저 복사해 의존성이 바뀌지 않으면 이 레이어를 캐시로 재사용합니다.
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
