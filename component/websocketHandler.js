const { WebSocketServer } = require('ws');
const {
    connections,
    userConnections,
    userInfoCache,
    pendingDisconnectTimers,
    getNextSocketId,
    broadcastOnlineUsers
} = require('./connectionState');
const { getColorForUser, parseUserTag } = require('../helper/userHelper');
const { getGraceSecondsForTag } = require('../helper/callbackConfig');
const { dispatchTagCallback } = require('./webhookDispatcher');

let currentIo = null;
let currentInternalSecret = '';

/**
 * Ngắt kết nối 1 user cụ thể (kick)
 */
async function kickUser(targetUserId, reason = 'admin_kick', message = 'Phiên làm việc của bạn đã bị ngắt bởi Quản trị viên.') {
    const sockets = userConnections.get(targetUserId);
    const kickPayload = JSON.stringify({
        type: 'kicked',
        reason: reason,
        message: message,
        timestamp: new Date().toISOString()
    });

    let count = 0;
    if (sockets && sockets.size > 0) {
        for (const ws of Array.from(sockets)) {
            ws.isKicked = true;
            if (ws.readyState === 1 /* WebSocket.OPEN */) {
                try { ws.send(kickPayload); } catch (e) {}
            }
            try {
                ws.close(4001, 'Kicked by admin');
            } catch (e) {}
            count++;
        }
    }
    return count;
}

/**
 * Ngắt kết nối TOÀN BỘ user đang online (Kick tất cả)
 */
async function kickAllUsers(reason = 'admin_kick', message = 'Hệ thống đã ngắt toàn bộ phiên kết nối bởi Quản trị viên.', exceptUserId = null) {
    const allUserIds = Array.from(userConnections.keys());
    let totalKicked = 0;
    for (const uid of allUserIds) {
        if (exceptUserId && String(uid) === String(exceptUserId)) {
            continue;
        }
        totalKicked += await kickUser(uid, reason, message);
    }
    return totalKicked;
}

function initWebSocket(server, io, config) {
    const { appKey, internalSecret } = config;
    currentIo = io;
    currentInternalSecret = internalSecret;
    const wss = new WebSocketServer({ noServer: true });

    /**
     * Gửi thông báo cập nhật số tab hiện tại tới TOÀN BỘ các kết nối/tab của một user
     */
    function notifyUserTabsCount(targetUserId, count) {
        const sockets = userConnections.get(targetUserId);
        if (!sockets) return;
        const payload = JSON.stringify({
            type: 'tabs_update',
            user_id: targetUserId,
            active_tabs: count,
            timestamp: new Date().toISOString()
        });
        for (const s of sockets) {
            if (s.readyState === 1 /* WebSocket.OPEN */) {
                try {
                    s.send(payload);
                } catch (e) {}
            }
        }
    }

    wss.on('connection', (ws, req, userId, clientInfo = {}) => {
        const socketId = getNextSocketId();
        ws.isAlive = true;

        const currentPage = clientInfo.page || '/';
        const currentParam = clientInfo.pageParam || '';
        const fullPage = clientInfo.fullPage || (currentPage + currentParam);

        // Lưu socket
        connections.set(ws, {
            socketId,
            userId,
            connectedAt: new Date(),
            ip: req.socket.remoteAddress,
            page: currentPage,
            pageParam: currentParam,
            fullPage: fullPage
        });

        const isFirstTab = !userConnections.has(userId) || userConnections.get(userId).size === 0;

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
        const { tag, rawId } = parseUserTag(userId);
        const existing = userInfoCache.get(userId);
        const name = (clientInfo.name || (existing ? existing.name : `User #${userId}`)).trim();
        const initial = (name.charAt(0) || 'U').toUpperCase();
        const color = getColorForUser(userId);

        userInfoCache.set(userId, {
            id: userId,
            tag: tag,
            raw_id: rawId,
            name: name,
            username: clientInfo.username || (existing ? existing.username : `${userId}`),
            initial: initial,
            color: color,
            page: currentPage,
            page_param: currentParam,
            full_page: fullPage,
            connected_at: existing?.connected_at || new Date().toISOString(),
            last_active_at: new Date().toISOString()
        });

        const activeTabsCount = userConnections.get(userId).size;
        console.log(`[${new Date().toLocaleTimeString()}] 🟢 [CONNECT] User #${userId} kết nối thành công (Page: "${fullPage}", Tab mở: ${activeTabsCount}, Socket ID: ${socketId})`);

        // Phiên đầu tiên -> Bắn callback method 'register'
        if (isFirstTab && tag) {
            dispatchTagCallback(tag, 'register', {
                user_id: userId,
                raw_id: rawId,
                name: clientInfo.name || '',
                username: clientInfo.username || '',
                page: currentPage,
                page_param: currentParam,
                full_page: fullPage,
                active_tabs: activeTabsCount,
                ip: req.socket.remoteAddress,
                connected_at: new Date().toISOString()
            }, rawId, internalSecret);
        }

        // Gửi thông báo kết nối thành công về client
        try {
            ws.send(JSON.stringify({
                type: 'connected',
                user_id: userId,
                active_tabs: activeTabsCount,
                timestamp: new Date().toISOString()
            }));
        } catch (e) {}

        // Đồng bộ số tab cho TOÀN BỘ các tab khác của user này (nếu đang mở nhiều tab)
        notifyUserTabsCount(userId, activeTabsCount);

        // Phát danh sách online users
        broadcastOnlineUsers(io);

        // Nhận message từ client
        ws.on('message', async (message) => {
            try {
                const data = JSON.parse(message.toString());
                if (data && (data.type === 'ping' || data.type === 'activity')) {
                    const uInfo = userInfoCache.get(userId);
                    if (uInfo) {
                        if (data.last_active_at) {
                            uInfo.last_active_at = data.last_active_at;
                        } else if (typeof data.inactive_seconds === 'number') {
                            uInfo.last_active_at = new Date(Date.now() - (data.inactive_seconds * 1000)).toISOString();
                        } else {
                            uInfo.last_active_at = new Date().toISOString();
                        }
                    }

                    if (data.type === 'activity') {
                        const wsData = connections.get(ws);
                        const curPage = wsData ? (wsData.fullPage || wsData.page || '/') : '/';
                        console.log(`[${new Date().toLocaleTimeString()}] ⚡ [ACTIVITY] User #${userId} tương tác tại: "${curPage}"`);

                        // Phát thông báo user_activity tức thì cho toàn bộ các client / dashboard
                        const actPayload = JSON.stringify({
                            type: 'user_activity',
                            user_id: userId,
                            last_active_at: uInfo ? uInfo.last_active_at : new Date().toISOString()
                        });
                        for (const [s] of connections) {
                            if (s.readyState === 1 /* WebSocket.OPEN */) {
                                try { s.send(actPayload); } catch (e) {}
                            }
                        }
                    }

                    if (data.type === 'ping') {
                        const currentTabs = userConnections.get(userId)?.size || 1;
                        ws.send(JSON.stringify({
                            type: 'pong',
                            user_id: userId,
                            active_tabs: currentTabs,
                            timestamp: new Date().toISOString()
                        }));
                    }
                } else if (data && data.type === 'navigate') {
                    // Hỗ trợ SPA Router: chuyển trang không reload
                    const newPage = data.page || '/';
                    const newParam = data.page_param || '';
                    const newFullPage = data.full_page || (newPage + newParam);

                    const wsData = connections.get(ws);
                    const oldPage = wsData ? wsData.page : '/';
                    const oldParam = wsData ? wsData.pageParam : '';
                    const oldFullPage = wsData ? wsData.fullPage : oldPage;

                    if (wsData) {
                        wsData.page = newPage;
                        wsData.pageParam = newParam;
                        wsData.fullPage = newFullPage;
                    }

                    const uInfo = userInfoCache.get(userId);
                    if (uInfo) {
                        uInfo.page = newPage;
                        uInfo.page_param = newParam;
                        uInfo.full_page = newFullPage;
                    }

                    const currentTabs = userConnections.get(userId)?.size || 1;
                    console.log(`[${new Date().toLocaleTimeString()}] 🧭 [SPA NAVIGATE] User #${userId} chuyển trang: "${oldFullPage}" ➔ "${newFullPage}" (Tab: ${currentTabs})`);

                    // Gửi xác nhận navigate kèm active_tabs về client
                    try {
                        ws.send(JSON.stringify({
                            type: 'navigate_ack',
                            user_id: userId,
                            active_tabs: currentTabs,
                            page: newPage,
                            page_param: newParam,
                            timestamp: new Date().toISOString()
                        }));
                    } catch (e) {}

                    const { tag: navTag, rawId: navRawId } = parseUserTag(userId);
                    if (navTag) {
                        await dispatchTagCallback(navTag, 'navigate', {
                            user_id: userId,
                            raw_id: navRawId,
                            page: newPage,
                            page_param: newParam,
                            full_page: newFullPage,
                            previous_page: oldPage,
                            previous_param: oldParam,
                            previous_full_page: oldFullPage,
                            active_tabs: currentTabs,
                            timestamp: new Date().toISOString()
                        }, navRawId, internalSecret);
                    }

                    broadcastOnlineUsers(io);
                } else if (data && data.type === 'inactivity_disconnect') {
                    console.log(`[${new Date().toLocaleTimeString()}] ⏱️ [INACTIVITY] User #${userId} gửi thông báo ngắt kết nối do không hoạt động.`);
                    const { tag: inactTag, rawId: inactRawId } = parseUserTag(userId);
                    if (inactTag) {
                        const wsData = connections.get(ws);
                        const currentTabs = userConnections.get(userId)?.size || 1;
                        await dispatchTagCallback(inactTag, 'disconnect', {
                            user_id: userId,
                            raw_id: inactRawId,
                            page: data.page || (wsData ? wsData.page : '/'),
                            page_param: data.page_param || (wsData ? wsData.pageParam : ''),
                            full_page: data.full_page || (wsData ? wsData.fullPage : '/'),
                            active_tabs: currentTabs,
                            reason: data.reason || 'inactivity_timeout',
                            disconnected_at: new Date().toISOString()
                        }, inactRawId, internalSecret);
                    }
                } else if (data && data.type === 'logout') {
                    console.log(`[${new Date().toLocaleTimeString()}] 🚪 [USER LOGOUT] User #${userId} gửi thông báo đăng xuất tài khoản -> Đóng tất cả tab/kết nối.`);
                    const sockets = userConnections.get(userId);
                    const logoutPayload = JSON.stringify({
                        type: 'kicked',
                        reason: 'user_logout',
                        message: 'Tài khoản của bạn đã đăng xuất khỏi hệ thống.',
                        timestamp: new Date().toISOString()
                    });

                    if (sockets && sockets.size > 0) {
                        for (const s of Array.from(sockets)) {
                            s.isKicked = true;
                            if (s.readyState === 1 /* WebSocket.OPEN */) {
                                try { s.send(logoutPayload); } catch (e) {}
                            }
                            try { s.close(4001, 'User logged out'); } catch (e) {}
                        }
                    }

                    userConnections.delete(userId);
                    userInfoCache.delete(userId);

                    if (pendingDisconnectTimers.has(userId)) {
                        clearTimeout(pendingDisconnectTimers.get(userId));
                        pendingDisconnectTimers.delete(userId);
                    }

                    broadcastOnlineUsers(io);

                    const { tag: lgTag, rawId: lgRawId } = parseUserTag(userId);
                    if (lgTag) {
                        const wsData = connections.get(ws);
                        await dispatchTagCallback(lgTag, 'disconnect', {
                            user_id: userId,
                            raw_id: lgRawId,
                            page: data.page || (wsData ? wsData.page : '/'),
                            page_param: data.page_param || (wsData ? wsData.pageParam : ''),
                            full_page: data.full_page || (wsData ? wsData.fullPage : '/'),
                            active_tabs: 0,
                            reason: 'logout',
                            disconnected_at: new Date().toISOString()
                        }, lgRawId, internalSecret);
                    }
                }
            } catch (err) {
                // Bỏ qua message không hợp lệ
            }
        });

        ws.on('pong', () => {
            ws.isAlive = true;
        });

        // Đóng tab hoặc ngắt kết nối
        ws.on('close', () => {
            const wsData = connections.get(ws);
            connections.delete(ws);

            const userSockets = userConnections.get(userId);
            if (userSockets) {
                userSockets.delete(ws);
                const remainingTabs = userSockets.size;
                console.log(`[${new Date().toLocaleTimeString()}] 🟡 [TAB CLOSED] Đóng tab Socket ID: ${socketId} của User #${userId} (Còn ${remainingTabs} tab khác)`);

                if (remainingTabs > 0) {
                    // Thông báo cho các tab còn lại của user biết số tab giảm
                    notifyUserTabsCount(userId, remainingTabs);
                    return;
                }

                userConnections.delete(userId);

                if (pendingDisconnectTimers.has(userId)) {
                    clearTimeout(pendingDisconnectTimers.get(userId));
                    pendingDisconnectTimers.delete(userId);
                }

                const { tag: disTag, rawId: disRawId } = parseUserTag(userId);
                const tagGraceSeconds = getGraceSecondsForTag(disTag);

                const performDisconnect = async () => {
                    pendingDisconnectTimers.delete(userId);

                    if (!userConnections.has(userId)) {
                        console.log(`[${new Date().toLocaleTimeString()}] 🔴 [USER OFFLINE] User #${userId} đã đóng toàn bộ tab.`);
                        userInfoCache.delete(userId);
                        broadcastOnlineUsers(io);

                        if (disTag) {
                            const pagePath = wsData ? wsData.page : '/';
                            const pageParam = wsData ? wsData.pageParam : '';
                            const fullPageStr = wsData ? wsData.fullPage : pagePath;
                            const disconnectReason = ws.isKicked ? 'admin_kick' : 'closed';
                            console.log(`[DISCONNECT] Gửi callback ngắt kết nối cho User #${userId} (Trang cuối: "${fullPageStr}", Lý do: ${disconnectReason}).`);
                            await dispatchTagCallback(disTag, 'disconnect', {
                                user_id: userId,
                                raw_id: disRawId,
                                page: pagePath,
                                page_param: pageParam,
                                full_page: fullPageStr,
                                active_tabs: 0,
                                reason: disconnectReason,
                                disconnected_at: new Date().toISOString()
                            }, disRawId, internalSecret);
                        }
                    }
                };

                if (ws.isKicked || tagGraceSeconds <= 0) {
                    performDisconnect();
                } else {
                    console.log(`[${new Date().toLocaleTimeString()}] ⏳ [GRACE PERIOD] Chờ ${tagGraceSeconds}s (Tag: ${disTag || 'default'}) xem User #${userId} có mở lại trang/F5 không...`);
                    const timer = setTimeout(performDisconnect, tagGraceSeconds * 1000);
                    pendingDisconnectTimers.set(userId, timer);
                }
            }
        });

        ws.on('error', (err) => {
            console.warn(`[WS ERROR] Socket #${socketId}:`, err.message);
        });
    });

    // Upgrade HTTP sang WebSocket
    server.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url, `http://${request.headers.host}`);
        const pathname = url.pathname;

        if (pathname.startsWith('/socket.io')) {
            return;
        }

        const requestKey = url.searchParams.get('appKey');
        if (appKey && requestKey && requestKey !== appKey) {
            console.warn(`[UPGRADE REJECTED] Sai appKey: ${requestKey}`);
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        const rawUserId = url.searchParams.get('user_id');
        if (!rawUserId || !rawUserId.trim()) {
            console.warn(`[UPGRADE REJECTED] Thiếu hoặc rỗng user_id`);
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
            return;
        }
        const userId = rawUserId.trim();

        const clientInfo = {
            name: url.searchParams.get('name') || '',
            username: url.searchParams.get('username') || '',
            page: url.searchParams.get('page') || '/',
            pageParam: url.searchParams.get('page_param') || '',
            fullPage: (url.searchParams.get('page') || '/') + (url.searchParams.get('page_param') || '')
        };

        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request, userId, clientInfo);
        });
    });

    // Heartbeat 30s dọn dead socket
    const heartbeatTimer = setInterval(() => {
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

    return { wss, heartbeatTimer };
}

module.exports = {
    initWebSocket,
    kickUser,
    kickAllUsers
};
