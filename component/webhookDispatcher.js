const { tagServices } = require('../helper/callbackConfig');

/**
 * Gọi webhook callback đến service tương ứng theo tag với payload tổng quát:
 * { method, tag, user_id, raw_user_id, data, secret, timestamp }
 */
async function dispatchTagCallback(tag, method, data, rawUserId, internalSecret = process.env.INTERNAL_SECRET || '13467902') {
    if (!tag) return;
    const service = tagServices.get(tag.toLowerCase().trim());
    if (!service || !service.callback) {
        return; // Không có callback nào cấu hình cho tag này
    }

    const payload = {
        method: method, // 'register', 'navigate', 'disconnect', ...
        tag: tag,
        user_id: data.user_id || `${tag}-${rawUserId}`,
        raw_user_id: rawUserId,
        data: data,
        secret: internalSecret,
        timestamp: new Date().toISOString()
    };

    try {
        console.log(`[CALLBACK DISPATCH] Gửi Method "${method}" (Tag: ${tag}, User: ${payload.user_id}) -> ${service.callback}`);
        const response = await fetch(service.callback, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Connection': 'close',
                'X-Internal-Secret': internalSecret
            },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            console.log(`✅ [CALLBACK SUCCESS] Method "${method}" User ${payload.user_id} (HTTP ${response.status})`);
        } else {
            console.warn(`⚠️ [CALLBACK FAILED] Method "${method}" Status ${response.status} cho User ${payload.user_id}`);
        }
    } catch (err) {
        console.error(`❌ [CALLBACK ERROR] Method "${method}" User ${payload.user_id}:`, err.message);
    }
}

module.exports = {
    dispatchTagCallback
};
