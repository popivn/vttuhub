const AVATAR_COLORS = [
    '#2563eb', '#059669', '#d97706', '#dc2626',
    '#7c3aed', '#db2777', '#0891b2', '#4b5563'
];

/**
 * Tính màu avatar ổn định dựa trên hash chuỗi hoặc số userId (hỗ trợ cả 'study-123')
 */
function getColorForUser(userId) {
    const str = String(userId);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = (hash << 5) - hash + str.charCodeAt(i);
        hash |= 0;
    }
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

/**
 * Trích xuất tiền tố tag trước dấu '-' (ví dụ 'study-15' -> tag: 'study', rawId: '15')
 */
function parseUserTag(userId) {
    const str = String(userId || '');
    const dashIndex = str.indexOf('-');
    if (dashIndex > 0) {
        return {
            tag: str.substring(0, dashIndex),
            rawId: str.substring(dashIndex + 1)
        };
    }
    return {
        tag: null,
        rawId: str
    };
}

module.exports = {
    AVATAR_COLORS,
    getColorForUser,
    parseUserTag
};
