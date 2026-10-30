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
    let resolvedKey = targetUserId;
    let sockets = userConnections.get(resolvedKey);

    // Nếu không tìm thấy bằng key trực tiếp, thử tìm theo rawId hoặc thêm tiền tố dental-
    if (!sockets || sockets.size === 0) {
        for (const [k, v] of userConnections.entries()) {
            const { rawId } = parseUserTag(k);
            if (rawId === String(targetUserId) || k === String(targetUserId) || k === `dental-${targetUserId}` || k === `study-${targetUserId}`) {
                sockets = v;
                resolvedKey = k;
                break;
            }
        }
    }

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
            if (typeof ws.send === 'function' && ws.readyState === 1 /* WebSocket.OPEN */) {
                try { ws.send(kickPayload); } catch (e) {}
            }
            if (typeof ws.emit === 'function') {
                try {
                    ws.emit('FORCE_LOGOUT', {
                        message: message,
                        reason: reason,
                        timestamp: new Date().toISOString()
                    });
                    ws.emit('kicked', {
                        reason: reason,
                        message: message,
                        timestamp: new Date().toISOString()
                    });
                } catch (e) {}
            }
            setTimeout(() => {
                try { if (typeof ws.close === 'function') ws.close(4001, 'Kicked by admin'); } catch (e) {}
                try { if (typeof ws.disconnect === 'function') ws.disconnect(true); } catch (e) {}
            }, 100);
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
            if (ws.isSocketIO) {
                continue;
            }
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
    // Khởi tạo Socket.IO Handler (Client Dental Care, v.v.)
    // ==========================================
    if (io) {
        io.on('connection', (socket) => {
            const auth = socket.handshake.auth || {};
            const query = socket.handshake.query || {};

            const rawUid = auth.userId || query.userId;
            if (!rawUid) {
                console.warn(`[Socket.IO REJECTED] Thiếu userId từ kết nối Socket.IO: ${socket.id}`);
                return socket.disconnect(true);
            }

            let { tag, rawId } = parseUserTag(rawUid);
            if (!tag) {
                tag = auth.tag || query.tag || 'dental';
            }
            const fullUserId = `${tag}-${rawId}`;
            const socketId = getNextSocketId();
            socket.isAlive = true;
            socket.isSocketIO = true;

            const currentPage = auth.page || query.page || '/';
            const currentParam = auth.pageParam || query.pageParam || '';
            const fullPage = auth.fullPage || (currentPage + currentParam);

            connections.set(socket, {
                socketId,
                userId: fullUserId,
                connectedAt: new Date(),
                ip: socket.handshake.address,
                page: currentPage,
                pageParam: currentParam,
                fullPage: fullPage
            });

            const isFirstTab = !userConnections.has(fullUserId) || userConnections.get(fullUserId).size === 0;

            if (!userConnections.has(fullUserId)) {
                userConnections.set(fullUserId, new Set());
            }
            userConnections.get(fullUserId).add(socket);

            if (pendingDisconnectTimers.has(fullUserId)) {
                clearTimeout(pendingDisconnectTimers.get(fullUserId));
                pendingDisconnectTimers.delete(fullUserId);
                console.log(`[${new Date().toLocaleTimeString()}] 🔄 [RELOAD/F5 Socket.IO] User #${fullUserId} tải lại trang - đã hủy timer disconnect.`);
            }

            const existing = userInfoCache.get(fullUserId);
            const name = (auth.name || query.name || (existing ? existing.name : `User #${rawId}`)).trim();
            const initial = (name.charAt(0) || 'U').toUpperCase();
            const color = getColorForUser(fullUserId);

            const sessionData = {
                id: fullUserId,
                tag: tag,
                raw_id: rawId,
                name: name,
                username: auth.username || query.username || (existing ? existing.username : `${rawId}`),
                email: auth.email || query.email || (existing ? existing.email : ''),
                role: auth.role || query.role || (existing ? existing.role : (auth.isStudent ? 'Sinh Viên' : 'Người Dùng')),
                isStudent: Boolean(auth.isStudent === true || auth.isStudent === 'true'),
                avatar: auth.avatar || auth.avater || query.avatar || query.avater || (existing ? existing.avatar : ''),
                avater: auth.avatar || auth.avater || query.avatar || query.avater || (existing ? existing.avater : ''),
                frame: auth.frame || query.frame || (existing ? existing.frame : ''),
                initial: initial,
                color: color,
                page: currentPage,
                page_param: currentParam,
                full_page: fullPage,
                connected_at: existing?.connected_at || new Date().toISOString(),
                last_active_at: new Date().toISOString()
            };
            userInfoCache.set(fullUserId, sessionData);

            const activeTabsCount = userConnections.get(fullUserId).size;
            console.log(`[${new Date().toLocaleTimeString()}] 🟢 [CONNECT Socket.IO] User #${fullUserId} ("${name}") kết nối thành công (Tab mở: ${activeTabsCount}, Socket ID: ${socket.id})`);

            socket.join(`user_${fullUserId}`);
            socket.join(`user_${rawId}`);

            if (isFirstTab && tag) {
                dispatchTagCallback(tag, 'register', {
                    user_id: fullUserId,
                    raw_id: rawId,
                    name: sessionData.name,
                    username: sessionData.username,
                    email: sessionData.email,
                    role: sessionData.role,
                    isStudent: sessionData.isStudent,
                    avatar: sessionData.avatar,
                    frame: sessionData.frame,
                    page: currentPage,
                    page_param: currentParam,
                    full_page: fullPage,
                    active_tabs: activeTabsCount,
                    ip: socket.handshake.address,
                    connected_at: new Date().toISOString()
                }, rawId, internalSecret);
            }

            // Gửi xác nhận kết nối về client
            socket.emit('connected', {
                type: 'connected',
                user_id: fullUserId,
                active_tabs: activeTabsCount,
                timestamp: new Date().toISOString()
            });

            // Đồng bộ cho các tab khác của user
            notifyUserTabsCount(fullUserId, activeTabsCount);

            // Broadcast user registered tới toàn bộ Socket.IO clients
            io.emit('user_registered', {
                userId: Number(rawId) || rawId,
                name: sessionData.name,
                username: sessionData.username,
                avatar: sessionData.avatar,
                frame: sessionData.frame,
                timestamp: new Date().toISOString()
            });

            broadcastOnlineUsers(io);

            // 1. Nhận sự kiện register_user từ client
            socket.on('register_user', (data) => {
                if (data) {
                    const uInfo = userInfoCache.get(fullUserId);
                    if (uInfo) {
                        if (data.name) uInfo.name = data.name;
                        if (data.username) uInfo.username = data.username;
                        if (data.email) uInfo.email = data.email;
                        if (data.role) uInfo.role = data.role;
                        if (data.isStudent !== undefined) uInfo.isStudent = Boolean(data.isStudent);
                        if (data.avatar || data.avater) {
                            uInfo.avatar = data.avatar || data.avater;
                            uInfo.avater = uInfo.avatar;
                        }
                        if (data.frame !== undefined) uInfo.frame = data.frame;
                    }
                    io.emit('user_registered', {
                        userId: Number(rawId) || rawId,
                        name: data.name || sessionData.name,
                        username: data.username || sessionData.username,
                        avatar: data.avatar || data.avater || sessionData.avatar,
                        frame: data.frame !== undefined ? data.frame : sessionData.frame,
                        timestamp: new Date().toISOString()
                    });
                    broadcastOnlineUsers(io);
                }
            });

            // 2. Nhận sự kiện update_avatar_frame
            socket.on('update_avatar_frame', (data) => {
                const targetRawId = data?.userId ? String(data.userId) : rawId;
                const targetFullId = `${tag}-${targetRawId}`;
                const uInfo = userInfoCache.get(targetFullId);
                const nextAvatar = data?.avatar || data?.avater || '';
                const nextFrame = data?.frame !== undefined ? data.frame : '';

                if (uInfo) {
                    uInfo.avatar = nextAvatar;
                    uInfo.avater = nextAvatar;
                    uInfo.frame = nextFrame;
                }

                io.emit('avatar_frame_updated', {
                    userId: Number(targetRawId) || targetRawId,
                    avatar: nextAvatar,
                    avater: nextAvatar,
                    frame: nextFrame,
                    timestamp: new Date().toISOString()
                });

                broadcastOnlineUsers(io);
            });

            // 3. Heartbeat / ping
            socket.on('heartbeat', () => {
                const uInfo = userInfoCache.get(fullUserId);
                if (uInfo) uInfo.last_active_at = new Date().toISOString();
            });

            socket.on('ping', () => {
                const currentTabs = userConnections.get(fullUserId)?.size || 1;
                socket.emit('pong', {
                    type: 'pong',
                    user_id: fullUserId,
                    active_tabs: currentTabs,
                    timestamp: new Date().toISOString()
                });
            });

            // 4. Logout
            socket.on('user_logout', async () => {
                console.log(`[${new Date().toLocaleTimeString()}] 🚪 [LOGOUT Socket.IO] User #${fullUserId} đăng xuất`);
                io.emit('user_logout', {
                    userId: Number(rawId) || rawId,
                    name: sessionData.name,
                    timestamp: new Date().toISOString()
                });

                const sockets = userConnections.get(fullUserId);
                if (sockets) {
                    for (const s of Array.from(sockets)) {
                        try { s.disconnect(true); } catch (e) {}
                    }
                }
                userConnections.delete(fullUserId);
                userInfoCache.delete(fullUserId);

                if (pendingDisconnectTimers.has(fullUserId)) {
                    clearTimeout(pendingDisconnectTimers.get(fullUserId));
                    pendingDisconnectTimers.delete(fullUserId);
                }

                broadcastOnlineUsers(io);

                if (tag) {
                    await dispatchTagCallback(tag, 'disconnect', {
                        user_id: fullUserId,
                        raw_id: rawId,
                        reason: 'logout',
                        disconnected_at: new Date().toISOString()
                    }, rawId, internalSecret);
                }
            });

            // 5. Disconnect (đóng tab)
            socket.on('disconnect', () => {
                connections.delete(socket);
                const userSockets = userConnections.get(fullUserId);
                if (userSockets) {
                    userSockets.delete(socket);
                    const remainingTabs = userSockets.size;
                    console.log(`[${new Date().toLocaleTimeString()}] 🟡 [TAB CLOSED Socket.IO] Đóng tab User #${fullUserId} (Còn ${remainingTabs} tab khác)`);

                    if (remainingTabs > 0) {
                        notifyUserTabsCount(fullUserId, remainingTabs);
                        return;
                    }

                    userConnections.delete(fullUserId);

                    if (pendingDisconnectTimers.has(fullUserId)) {
                        clearTimeout(pendingDisconnectTimers.get(fullUserId));
                        pendingDisconnectTimers.delete(fullUserId);
                    }

                    const tagGraceSeconds = getGraceSecondsForTag(tag);
                    const performDisconnect = async () => {
                        pendingDisconnectTimers.delete(fullUserId);
                        if (!userConnections.has(fullUserId)) {
                            console.log(`[${new Date().toLocaleTimeString()}] 🔴 [USER OFFLINE Socket.IO] User #${fullUserId} đã đóng toàn bộ tab.`);
                            userInfoCache.delete(fullUserId);

                            io.emit('user_disconnected', {
                                userId: Number(rawId) || rawId,
                                name: sessionData.name,
                                timestamp: new Date().toISOString()
                            });

                            broadcastOnlineUsers(io);

                            if (tag) {
                                await dispatchTagCallback(tag, 'disconnect', {
                                    user_id: fullUserId,
                                    raw_id: rawId,
                                    reason: socket.isKicked ? 'admin_kick' : 'closed',
                                    disconnected_at: new Date().toISOString()
                                }, rawId, internalSecret);
                            }
                        }
                    };

                    if (socket.isKicked || tagGraceSeconds <= 0) {
                        performDisconnect();
                    } else {
                        console.log(`[${new Date().toLocaleTimeString()}] ⏳ [GRACE PERIOD Socket.IO] Chờ ${tagGraceSeconds}s (Tag: ${tag}) xem User #${fullUserId} có mở lại trang/F5 không...`);
                        const timer = setTimeout(performDisconnect, tagGraceSeconds * 1000);
                        pendingDisconnectTimers.set(fullUserId, timer);
                    }
                }
            });
        });
    }

    return { wss, heartbeatTimer };
}

module.exports = {
    initWebSocket,
    kickUser,
    kickAllUsers
};
