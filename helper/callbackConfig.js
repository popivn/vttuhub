const fs = require('fs');
const path = require('path');

/**
 * Quản lý cấu hình Callback theo Tag (đọc từ callbacks.json hoặc callbacks.txt)
 * Map: tag -> { tag, callback, graceSeconds }
 */
const tagServices = new Map();

function loadCallbacksConfig(baseDir = path.resolve(__dirname, '..')) {
    tagServices.clear();
    const jsonPath = path.join(baseDir, 'callbacks.json');
    const txtPath = path.join(baseDir, 'callbacks.txt');
    const filePath = fs.existsSync(jsonPath) ? jsonPath : (fs.existsSync(txtPath) ? txtPath : null);

    if (filePath) {
        try {
            const raw = fs.readFileSync(filePath, 'utf-8').trim();
            // Loại bỏ comment // hoặc /* */ nếu người dùng ghi chú trong file JSON
            const cleanJson = raw.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, '$1').trim();
            if (cleanJson.startsWith('{')) {
                const parsed = JSON.parse(cleanJson);
                for (const [key, val] of Object.entries(parsed)) {
                    if (val && typeof val === 'object') {
                        const tag = (val.STUDY_TAG || val.tag || val[`${key.toUpperCase()}_TAG`] || key).toLowerCase().trim();
                        // Ưu tiên biến môi trường nếu có override cho test local
                        const callback = (process.env[`${key.toUpperCase()}_CALLBACK`] || val.STUDY_CALLBACK || val.callback || val[`${key.toUpperCase()}_CALLBACK`] || val.url || '').trim();
                        const rawGrace = val.GRACE_SECONDS ?? val.grace_seconds ?? val.grace ?? val[`${key.toUpperCase()}_GRACE_SECONDS`] ?? 0;
                        const graceSeconds = Math.max(0, parseInt(rawGrace, 10) || 0);

                        if (tag && callback) {
                            tagServices.set(tag, {
                                tag: tag,
                                callback: callback,
                                graceSeconds: graceSeconds
                            });
                            console.log(`[CALLBACK CONFIG] Tag [${tag}] -> Callback: ${callback} (Grace: ${graceSeconds}s)`);
                        }
                    }
                }
            }
        } catch (err) {
            console.error(`[CALLBACK CONFIG ERROR] Lỗi đọc cấu hình từ ${filePath}:`, err.message);
        }
    }
    return tagServices;
}

/**
 * Lấy số giây Grace Period cấu hình riêng cho từng tag/ứng dụng
 */
function getGraceSecondsForTag(tag) {
    if (!tag) return 0;
    const service = tagServices.get(tag.toLowerCase().trim());
    return service ? (service.graceSeconds || 0) : 0;
}

module.exports = {
    tagServices,
    loadCallbacksConfig,
    getGraceSecondsForTag
};
