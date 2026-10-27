require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server: SocketIOServer } = require('socket.io');

const { tagServices, loadCallbacksConfig } = require('./helper/callbackConfig');
const { initWebSocket } = require('./component/websocketHandler');
const createRoutes = require('./route');

// Cấu hình môi trường
const PORT = process.env.PORT || 3000;
const APP_KEY = process.env.APP_KEY || 'vttu_key_2026';
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '13467902';

// Nạp danh sách callback & Grace Period riêng của từng tag từ callbacks.json / callbacks.txt
loadCallbacksConfig(__dirname);

// Khởi tạo Express & HTTP Server
const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// Khởi tạo Socket.IO Server
const io = new SocketIOServer(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// Đăng ký REST API routes
app.use('/', createRoutes(io, {
    internalSecret: INTERNAL_SECRET
}));

// Khởi tạo Native WebSocket Server & Upgrade Listener
initWebSocket(server, io, {
    appKey: APP_KEY,
    internalSecret: INTERNAL_SECRET
});

// Khởi động server
server.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚀 [VTTU REALTIME HUB] Server đang chạy tại PORT: ${PORT}`);
    console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}/ws/student-tracker`);
    console.log(`🔗 Tag Services:`);
    if (tagServices.size > 0) {
        for (const [t, s] of tagServices.entries()) {
            console.log(`   - [${t}]: ${s.callback} (Grace: ${s.graceSeconds}s)`);
        }
    } else {
        console.log(`   (Chưa cấu hình service nào trong callbacks.json / callbacks.txt)`);
    }
    console.log(`=======================================================`);
});
