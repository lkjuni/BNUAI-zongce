# 综合测评自动算分系统 - Docker 镜像
# Node.js 原生 HTTP 服务，无需 nginx
FROM node:20-alpine

# 设置工作目录
WORKDIR /app

# 复制依赖描述文件并安装
COPY package.json ./
RUN npm install --production --ignore-scripts

# 复制源代码和静态资源
COPY public/ ./public/
COPY src/ ./src/
COPY sql/schema.sql ./sql/schema.sql
COPY sql/006_ai_audit.sql ./sql/006_ai_audit.sql

# 创建上传目录
RUN mkdir -p uploads/applications

# 暴露端口
EXPOSE 5173

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5173/api/health', (r)=>{process.exit(r.statusCode===200?0:1)})"

# 启动
CMD ["node", "src/server.js"]