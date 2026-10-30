# ==========================================
# Dockerfile cho VTTU Realtime Hub
# Chạy trên nền Node.js 20 Alpine siêu nhẹ
# ==========================================

FROM node:20-alpine

# Thiết lập thư mục làm việc trong container
WORKDIR /app

# Thiết lập biến môi trường mặc định (chạy cổng 6001)
ENV NODE_ENV=production
ENV PORT=6001

# Copy file định nghĩa package để tận dụng Docker layer cache
COPY package*.json ./

# Cài đặt dependencies (chỉ lấy production, bỏ qua devDependencies)
RUN npm ci --omit=dev

# Copy toàn bộ mã nguồn vào container
COPY . .

# Đổi quyền sở hữu thư mục app cho user node (được tích hợp sẵn trong node-alpine)
RUN chown -R node:node /app

# Chuyển sang user non-root để đảm bảo bảo mật
USER node

# Mở cổng 6001 trong container
EXPOSE 6001

# Lệnh khởi động server
CMD ["node", "server.js"]

