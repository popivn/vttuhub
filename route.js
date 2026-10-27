const express = require('express');
const { WebSocket } = require('ws');
const {
    connections,
    userConnections,
    getOnlineUsersList
} = require('./component/connectionState');
const { tagServices } = require('./helper/callbackConfig');
const { parseUserTag } = require('./helper/userHelper');

/**
 * Khởi tạo các Route cho Realtime Hub
 * @param {object} io - Socket.IO instance
 * @param {object} config - Các biến cấu hình ({ internalSecret })
 */
function createRoutes(io, config = {}) {
    const router = express.Router();
    const internalSecret = config.internalSecret || process.env.INTERNAL_SECRET || '13467902';

    // Dashboard trạng thái máy chủ
    router.get('/', (req, res) => {
        const onlineUserIds = Array.from(userConnections.keys());
        const tagsSummary = {};
        for (const id of onlineUserIds) {
            const { tag } = parseUserTag(id);
            const t = tag || 'other';
            tagsSummary[t] = (tagsSummary[t] || 0) + 1;
        }

        res.json({
            service: 'VTTU Realtime Hub',
            status: 'online',
            uptime_seconds: Math.floor(process.uptime()),
            memory_usage_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
            active_sockets: connections.size,
            online_users_count: onlineUserIds.length,
            tags_summary: tagsSummary,
            online_user_ids: onlineUserIds,
            timestamp: new Date().toISOString()
        });
    });

    // Health check endpoint
    router.get('/health', (req, res) => {
        res.status(200).send('OK');
    });

    /**
     * Handler lấy danh sách user online (hỗ trợ lọc theo tag)
     */
    function handleGetOnlineUsers(req, res) {
        const filterTag = req.params.tag || req.query.tag || req.query.prefix || null;
        const users = getOnlineUsersList(filterTag);

        // Thống kê tổng hợp số lượng user online theo từng tag
        const allUsers = filterTag ? getOnlineUsersList() : users;
        const tagsSummary = {};
        for (const u of allUsers) {
            const t = u.tag || 'other';
            tagsSummary[t] = (tagsSummary[t] || 0) + 1;
        }

        const serviceInfo = filterTag ? tagServices.get(String(filterTag).toLowerCase().trim()) : null;

        res.json({
            filter_tag: filterTag ? String(filterTag).trim() : null,
            callback_url: serviceInfo ? serviceInfo.callback : null,
            total: users.length,
            total_sockets: connections.size,
            tags_summary: tagsSummary,
            users: users,
            timestamp: new Date().toISOString()
        });
    }

    // Endpoints danh sách user online
    router.get('/api/online-users', handleGetOnlineUsers);
    router.get('/api/online-users/:tag', handleGetOnlineUsers);
    router.get('/api/users/online', handleGetOnlineUsers);
    router.get('/api/users/online/:tag', handleGetOnlineUsers);

    // Endpoint Broadcast thông báo tới client từ server backend (Laravel, v.v.)
    router.post('/api/broadcast', (req, res) => {
        const secret = req.headers['x-internal-secret'] || req.body.key;
        if (secret !== internalSecret) {
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
            const targetKey = String(target_user_id).trim();
            const sockets = userConnections.get(targetKey);
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

        // Đồng thời phát qua Socket.IO (nếu có client kết nối)
        if (io) {
            if (target_user_id) {
                io.to(`user_${target_user_id}`).emit(type || 'notification', payload);
            } else {
                io.emit(type || 'notification', payload);
            }
        }

        return res.json({
            success: true,
            sent_clients: sentCount
        });
    });

    return router;
}

module.exports = createRoutes;
