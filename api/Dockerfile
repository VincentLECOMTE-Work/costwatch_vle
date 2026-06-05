FROM node:24-bookworm-slim
WORKDIR /app
ENV AWS_SDK_LOAD_CONFIG=1
COPY package.json package-lock.json* ./
RUN npm ci || npm i
COPY src ./src
COPY sql ./sql
EXPOSE 8081
CMD ["npm","start"]
