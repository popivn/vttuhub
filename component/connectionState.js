const { WebSocket } = require('ws');
const { getColorForUser, parseUserTag } = require('../helper/userHelper');

let nextSocketId = 1;
// Map: ws connection -> { socketId, userId, connectedAt, isAlive, page, pageParam, fullPage, ip }
const connections = new Map();
// Map: userId -> Set<ws connection> (hỗ trợ 1 học viên mở nhiều tab cùng lúc)
const userConnections = new Map();
// Map: userId -> { id, tag, raw_id, name, username, initial, color, page, page_param, full_page, connected_at }
const userInfoCache = new Map();
// Map: userId -> Timeout handle (Grace period chờ 8s khi tắt hết tab)
const pendingDisconnectTimers = new Map();

function getNextSocketId() {
    return nextSocketId++;
}

/**
 * Lấy danh sách đầy đủ thông tin các user đang online kèm số tab/socket đang mở
 * Hỗ trợ filter theo tiền tố tag (ví dụ 'study' sẽ lọc các user 'study-xx')
 */
function getOnlineUsersList(filterTag = null) {
    const result = [];
    const normalizedFilterTag = filterTag ? String(filterTag).toLowerCase().trim() : null;

    for (const [userId, sockets] of userConnections.entries()) {
        const { tag, rawId } = parseUserTag(userId);

        if (normalizedFilterTag && (!tag || tag.toLowerCase() !== normalizedFilterTag)) {
            continue;
        }

        let info = userInfoCache.get(userId);
        if (!info) {
            info = {
                id: userId,
                tag: tag,
                raw_id: rawId,
                name: `User #${userId}`,
                username: `${userId}`,
                initial: 'U',
                color: getColorForUser(userId),
                connected_at: new Date().toISOString()
            };
        }

        const lastActiveTime = info.last_active_at ? new Date(info.last_active_at).getTime() : (info.connected_at ? new Date(info.connected_at).getTime() : Date.now());
        const inactiveSeconds = Math.max(0, Math.floor((Date.now() - lastActiveTime) / 1000));

        result.push({
            id: info.id,
            tag: info.tag || tag,
            raw_id: info.raw_id || rawId,
            name: info.name,
            username: info.username,
            initial: info.initial,
            color: info.color,
            page: info.page || '/',
            page_param: info.page_param || '',
            full_page: info.full_page || (info.page || '/'),
            active_tabs: sockets ? sockets.size : 1,
            connected_at: info.connected_at || null,
            last_active_at: info.last_active_at || info.connected_at || new Date().toISOString(),
            inactive_seconds: inactiveSeconds
        });
    }

    return result;
}

/**
 * Hàm phát danh sách học viên đang online tới toàn bộ client
 */
function broadcastOnlineUsers(io = null) {
    const usersData = getOnlineUsersList();

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
    if (io) {
        io.emit('online_users_update', {
            total: usersData.length,
            users: usersData,
            timestamp: new Date().toISOString()
        });
    }
}

module.exports = {
    connections,
    userConnections,
    userInfoCache,
    pendingDisconnectTimers,
    getNextSocketId,
    getOnlineUsersList,
    broadcastOnlineUsers
};
