require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer, WebSocket } = require('ws');
const { Server: SocketIOServer } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Cấu hình môi trường
const PORT = process.env.PORT || 3000;
const APP_KEY = process.env.APP_KEY || 'vttu_key_2026';
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '13467902';
const STUDY_API_URL = (process.env.STUDY_API_URL || 'http://localhost:8000').replace(/\/+$/, '');
const GRACE_SECONDS = parseInt(process.env.GRACE_SECONDS || '8', 10);

app.use(cors());
app.use(express.json());

// Bảng màu avatar đại diện (đồng bộ với Study)
const AVATAR_COLORS = [
    '#2563eb', '#059669', '#d97706', '#dc2626',
    '#7c3aed', '#db2777', '#0891b2', '#4b5563'
];

/**
 * Quản lý trạng thái kết nối trong RAM
 */
let nextSocketId = 1;
// Map: ws connection -> { socketId, userId, connectedAt, isAlive }
const connections = new Map();
// Map: userId -> Set<ws connection> (hỗ trợ 1 học viên mở nhiều tab cùng lúc)
const userConnections = new Map();
// Map: userId -> { id, name, username, initial, color }
const userInfoCache = new Map();
// Map: userId -> Timeout handle (Grace period chờ 8s khi tắt hết tab)
const pendingDisconnectTimers = new Map();

/**
 * Native WebSocket Server (hỗ trợ client thuần ws như student-websocket-tracker.js)
 */
const wss = new WebSocketServer({ noServer: true });

/**
 * Socket.IO Server (sẵn sàng cho các tính năng realtime mở rộng trong tương lai)
 */
const io = new SocketIOServer(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

/**
 * Hàm phát danh sách học viên đang online tới toàn bộ client
 */
function broadcastOnlineUsers() {
    const onlineUserIds = Array.from(userConnections.keys());
    const usersData = [];

    for (const uId of onlineUserIds) {
        let uInfo = userInfoCache.get(uId);
        if (!uInfo) {
            const color = AVATAR_COLORS[uId % AVATAR_COLORS.length];
            uInfo = {
                id: uId,
                name: `User #${uId}`,
                username: `${uId}`,
                initial: 'U',
                color: color
            };
            userInfoCache.set(uId, uInfo);
        }
        usersData.push(uInfo);
    }

    const payload = JSON.stringify({
        type: 'online_users_update',
        total: usersData.length,
        users: usersData,
        timestamp: new Date().toISOString()
    });

    // 1. Gửi tới tất cả native WebSocket clients
    for (const [clientWs] of connections.entries()) {
        if (clientWs.readyState === WebSocket.OPEN) {
            try {
                clientWs.send(payload);
            } catch (err) {
                console.error(`[WS SEND ERROR] Socket #${connections.get(clientWs)?.socketId}:`, err.message);
            }
        }
    }

    // 2. Gửi tới Socket.IO clients (nếu có)
    io.emit('online_users_update', {
        total: usersData.length,
        users: usersData,
        timestamp: new Date().toISOString()
    });
}

/**
 * Báo cho Laravel Study biết khi học viên ngắt kết nối hoàn toàn để chốt thời lượng học vào MySQL
 */
async function notifyLaravelUserDisconnect(userId) {
    if (!STUDY_API_URL) return;

    const endpoint = `${STUDY_API_URL}/api/internal/student-disconnect`;
    try {
        console.log(`[LARAVEL WEBHOOK] Gửi thông báo ngắt kết nối User #${userId} tới: ${endpoint}`);
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Internal-Secret': INTERNAL_SECRET
            },
            body: JSON.stringify({
                user_id: userId,
                key: INTERNAL_SECRET
            })
        });

        if (response.ok) {
            const data = await response.json();
            console.log(`✅ [LARAVEL WEBHOOK SUCCESS] User #${userId}:`, data);
        } else {
            console.warn(`⚠️ [LARAVEL WEBHOOK FAILED] Status ${response.status} cho User #${userId}`);
        }
    } catch (err) {
        console.error(`❌ [LARAVEL WEBHOOK ERROR] User #${userId}:`, err.message);
    }
}

/**
 * Xử lý kết nối Native WebSocket
 */
wss.on('connection', (ws, req, userId, clientInfo = {}) => {
    const socketId = nextSocketId++;
    ws.isAlive = true;

    // Lưu socket
    connections.set(ws, {
        socketId,
        userId,
        connectedAt: new Date(),
        ip: req.socket.remoteAddress
    });

    // Quản lý tab của user
    if (!userConnections.has(userId)) {
        userConnections.set(userId, new Set());
    }
    userConnections.get(userId).add(ws);

    // Nếu user có timer đếm ngược disconnect (vừa reload F5 hoặc chuyển trang) -> HỦY NGAY
    if (pendingDisconnectTimers.has(userId)) {
        clearTimeout(pendingDisconnectTimers.get(userId));
        pendingDisconnectTimers.delete(userId);
        console.log(`[${new Date().toLocaleTimeString()}] 🔄 [RELOAD/F5] User #${userId} tải lại trang - đã hủy timer disconnect.`);
    }

    // Cập nhật thông tin hiển thị avatar nếu client có truyền
    if (clientInfo.name || !userInfoCache.has(userId)) {
        const name = (clientInfo.name || `User #${userId}`).trim();
        const initial = (name.charAt(0) || 'U').toUpperCase();
        const color = AVATAR_COLORS[userId % AVATAR_COLORS.length];
        userInfoCache.set(userId, {
            id: userId,
            name: name,
            username: clientInfo.username || `${userId}`,
            initial: initial,
            color: color
        });
    }

    const activeTabsCount = userConnections.get(userId).size;
    console.log(`[${new Date().toLocaleTimeString()}] 🟢 [CONNECT] User #${userId} kết nối thành công (Tab mở: ${activeTabsCount}, Socket ID: ${socketId})`);

    // Gửi thông báo kết nối thành công về client
    try {
        ws.send(JSON.stringify({
            type: 'connected',
            user_id: userId,
            active_tabs: activeTabsCount,
            timestamp: new Date().toISOString()
        }));
    } catch (e) {}

    // Phát danh sách online users cập nhật mới nhất cho tất cả client
    broadcastOnlineUsers();

    // Nhận message từ client
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            if (data && data.type === 'ping') {
                ws.send(JSON.stringify({
                    type: 'pong',
                    timestamp: new Date().toISOString()
                }));
            }
        } catch (err) {
            // bỏ qua message không hợp lệ
        }
    });

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    // Đóng tab hoặc ngắt kết nối
    ws.on('close', () => {
        connections.delete(ws);

        const userSockets = userConnections.get(userId);
        if (userSockets) {
            userSockets.delete(ws);
            const remainingTabs = userSockets.size;
            console.log(`[${new Date().toLocaleTimeString()}] 🟡 [TAB CLOSED] Đóng tab Socket ID: ${socketId} của User #${userId} (Còn ${remainingTabs} tab khác)`);

            // Nếu user vẫn còn tab khác đang mở -> không tính là disconnect
            if (remainingTabs > 0) {
                return;
            }

            // Hết tất cả các tab -> Kích hoạt Grace Period đếm ngược
            userConnections.delete(userId);

            if (pendingDisconnectTimers.has(userId)) {
                clearTimeout(pendingDisconnectTimers.get(userId));
            }

            console.log(`[${new Date().toLocaleTimeString()}] ⏳ [GRACE PERIOD] Chờ ${GRACE_SECONDS}s xem User #${userId} có mở lại trang/F5 không...`);

            const timer = setTimeout(async () => {
                pendingDisconnectTimers.delete(userId);

                // Kiểm tra lại lần cuối: nếu user vẫn không có tab nào mở lại
                if (!userConnections.has(userId)) {
                    console.log(`[${new Date().toLocaleTimeString()}] 🔴 [DISCONNECT] User #${userId} đã rời khỏi hệ thống. Báo Laravel chốt log.`);
                    userInfoCache.delete(userId);
                    broadcastOnlineUsers();
                    await notifyLaravelUserDisconnect(userId);
                }
            }, GRACE_SECONDS * 1000);

            pendingDisconnectTimers.set(userId, timer);
        }
    });

    ws.on('error', (err) => {
        console.warn(`[WS ERROR] Socket #${socketId}:`, err.message);
    });
});

/**
 * Xử lý Upgrade HTTP sang WebSocket (Bắt cả đường dẫn /ws/student-tracker và mặc định)
 */
server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const pathname = url.pathname;

    // Bỏ qua nếu là request của Socket.IO (Socket.IO tự xử lý upgrade của nó)
    if (pathname.startsWith('/socket.io')) {
        return;
    }

    // Kiểm tra bảo mật appKey
    const requestKey = url.searchParams.get('appKey');
    if (APP_KEY && requestKey && requestKey !== APP_KEY) {
        console.warn(`[UPGRADE REJECTED] Sai appKey: ${requestKey}`);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }

    // Lấy thông tin user
    const userId = parseInt(url.searchParams.get('user_id'), 10);
    if (!userId || isNaN(userId) || userId <= 0) {
        console.warn(`[UPGRADE REJECTED] Thiếu hoặc sai user_id`);
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
    }

    const clientInfo = {
        name: url.searchParams.get('name') || '',
        username: url.searchParams.get('username') || ''
    };

    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request, userId, clientInfo);
    });
});

/**
 * Heartbeat định kỳ mỗi 30s dọn dẹp các socket mất kết nối bất thường (dead connections)
 */
setInterval(() => {
    for (const [ws, data] of connections.entries()) {
        if (ws.isAlive === false) {
            console.log(`[HEARTBEAT CLEANUP] Dọn dẹp dead socket #${data.socketId} của User #${data.userId}`);
            ws.terminate();
            continue;
        }
        ws.isAlive = false;
        try {
            ws.ping();
        } catch (e) {}
    }
}, 30000);

// ==========================================
// REST API & HEALTH CHECK
// ==========================================

// Dashboard trạng thái máy chủ
app.get('/', (req, res) => {
    const onlineUserIds = Array.from(userConnections.keys());
    res.json({
        service: 'VTTU Realtime Hub',
        status: 'online',
        uptime_seconds: Math.floor(process.uptime()),
        memory_usage_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        active_sockets: connections.size,
        online_users_count: onlineUserIds.length,
        online_user_ids: onlineUserIds,
        timestamp: new Date().toISOString()
    });
});

// Render Health Check endpoint
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Lấy danh sách user online
app.get('/api/online-users', (req, res) => {
    const users = Array.from(userInfoCache.values());
    res.json({
        total: users.length,
        users: users
    });
});

// Laravel Study gọi sang để phát thông báo realtime cho sinh viên
app.post('/api/broadcast', (req, res) => {
    const secret = req.headers['x-internal-secret'] || req.body.key;
    if (secret !== INTERNAL_SECRET) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const { type, payload, target_user_id } = req.body;
    const message = JSON.stringify({
        type: type || 'notification',
        payload: payload || {},
        timestamp: new Date().toISOString()
    });

    let sentCount = 0;
    if (target_user_id) {
        const sockets = userConnections.get(parseInt(target_user_id, 10));
        if (sockets) {
            for (const ws of sockets) {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(message);
                    sentCount++;
                }
            }
        }
    } else {
        for (const [ws] of connections.entries()) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(message);
                sentCount++;
            }
        }
    }

    // Đồng thời phát qua Socket.IO
    if (target_user_id) {
        io.to(`user_${target_user_id}`).emit(type || 'notification', payload);
    } else {
        io.emit(type || 'notification', payload);
    }

    return res.json({
        success: true,
        sent_clients: sentCount
    });
});

// Khởi động server
server.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚀 [VTTU REALTIME HUB] Server đang chạy tại PORT: ${PORT}`);
    console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}/ws/student-tracker`);
    console.log(`🔗 Webhook Laravel URL: ${STUDY_API_URL}`);
    console.log(`⏳ Grace Period: ${GRACE_SECONDS}s`);
    console.log(`=======================================================`);
});
