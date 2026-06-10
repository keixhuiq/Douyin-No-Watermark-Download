// background.js
// 职责：
//   1) 维护 Referer 规则（让抖音 CDN 域名的请求带正确的 Referer）
//   2) 解析 CDN 重定向（fetch 跟随 302，把短 URL 换成最终 URL）
// 下载本身由 content.js 用 fetch + blob + <a download> 触发，
// 这样 Chrome 把它当作"用户主动下载"，Save As 弹框会记住上次保存位置。

const RULE_IDS = [99999, 99998, 99997, 99996, 99995, 99994, 99993, 99992, 99991, 99990, 99989];

const RULE_FILTERS = [
    '*douyinvod*',
    '*douyin.com/aweme*',
    '*bytecdn*',
    '*ixigua*',
    '*zjcdn*',
    '*douyinpic*',
    '*byteimg*',
    '*pstatp*',
    '*feishucdn*',
    '*bytedance*',
    '*bdxiguaimg*',
];

chrome.runtime.onInstalled.addListener(() => setupRules());
chrome.runtime.onStartup.addListener(() => setupRules());

async function setupRules() {
    try {
        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: RULE_IDS,
            addRules: RULE_FILTERS.map((f, i) => makeRule(RULE_IDS[i], f)),
        });
        console.log('[DY-DL BG] Referer 规则已设置:', RULE_FILTERS.length, '条');
    } catch (e) {
        console.warn('[DY-DL BG] 规则设置失败:', e);
    }
}

// 自愈：需要用到规则时，若缺失则重建
async function ensureRules() {
    try {
        const rules = await chrome.declarativeNetRequest.getDynamicRules();
        const existing = new Set(rules.map(r => r.id));
        const missing = RULE_IDS.some(id => !existing.has(id));
        if (missing) {
            console.log('[DY-DL BG] 检测到规则缺失，重建');
            await setupRules();
        }
    } catch (e) {
        console.warn('[DY-DL BG] 规则检查失败:', e);
    }
}

function makeRule(id, urlFilter) {
    return {
        id, priority: 1,
        action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'Referer', operation: 'set', value: 'https://www.douyin.com/' }]
        },
        condition: {
            urlFilter,
            // 关键：DNR 动态规则是全浏览器生效的。原版没有 initiatorDomains，
            // 意味着用户正常访问飞书（feishucdn）、西瓜等 ByteDance 系站点时
            // Referer 也会被改写成抖音——既影响兼容性也是隐私瑕疵。
            // 现在限定为：
            //   1) douyin.com 页面发起的请求（content script 的 fetch）
            //   2) 扩展自身（service worker 的 resolveUrl/fetchBlob，
            //      initiator 是 chrome-extension://<id>；Referer 是 fetch
            //      禁设头，SW 里手动设置无效，全靠这条规则生效）
            initiatorDomains: [chrome.runtime.id, 'douyin.com'],
            // 不含 main_frame/sub_frame：下载只涉及 XHR/媒体/图片
            resourceTypes: ['xmlhttprequest', 'media', 'image', 'other']
        }
    };
}

// ===== 全局快捷键（chrome://extensions/shortcuts 可自定义，默认 Alt+Shift+D） =====
// 注意默认值刻意与 TikTok 版（Alt+D）错开，两个扩展同时安装时不冲突
chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'download-current') return;
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id && /^https?:\/\/([^/]*\.)?douyin\.com\//.test(tab.url || '')) {
            chrome.tabs.sendMessage(tab.id, { action: 'trigger_download' }).catch(() => { });
        }
    } catch (e) { /* ignore */ }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'resolve_url') {
        ensureRules().finally(() => resolveUrl(msg.url, sendResponse));
        return true;
    }
    if (msg.action === 'fetch_blob') {
        ensureRules().finally(() => fetchBlob(msg.url, msg.credentials, sendResponse));
        return true;
    }
    if (msg.action === 'ping') {
        sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
        return false;
    }
});

// ===== 跨域 fetch 兜底（从 TikTok 版回灌） =====
// 抖音 CDN 偶发不返回 CORS 头，content script 直接 fetch 会被浏览器拦截。
// service worker 的 fetch 不受页面 CORS 限制，由这里代取。
// 注意：sendMessage 结构化克隆有大小上限（实测约 64MB），
// 此路径仅作为兜底，主路径仍是 content.js 直接 fetch。
async function fetchBlob(url, credentials, sendResponse) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);

    try {
        const res = await fetch(url, {
            headers: { 'Referer': 'https://www.douyin.com/', 'Accept': '*/*' },
            redirect: 'follow',
            credentials: credentials || 'omit',
            cache: 'no-store',
            signal: ctrl.signal,
        });
        if (!res.ok) {
            sendResponse({ ok: false, error: `HTTP ${res.status}` });
            return;
        }
        const ct = res.headers.get('Content-Type') || '';
        if (ct.includes('text/html')) {
            sendResponse({ ok: false, error: `非媒体响应 (${ct})` });
            return;
        }
        const buffer = await res.arrayBuffer();
        if (buffer.byteLength < 100) {
            sendResponse({ ok: false, error: `文件过小 (${buffer.byteLength}B)` });
            return;
        }
        sendResponse({
            ok: true,
            buffer,
            contentType: ct,
            size: buffer.byteLength,
        });
    } catch (err) {
        sendResponse({
            ok: false,
            error: err.name === 'AbortError' ? '获取超时' : err.message,
        });
    } finally {
        clearTimeout(timer);
    }
}

// ===== 解析 CDN 重定向 =====
// 抖音返回的 play URL 通常是短链，会 302 重定向到真实 CDN 地址。
// 在 service worker 里做探测，拿到最终 URL 再交给前端 fetch 下载。

async function resolveUrl(url, sendResponse) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);

    try {
        const res = await fetch(url, {
            headers: { 'Referer': 'https://www.douyin.com/' },
            redirect: 'follow',
            signal: ctrl.signal,
        });
        const ct = res.headers.get('Content-Type') || '';
        const cl = res.headers.get('Content-Length') || '0';
        const finalUrl = res.url;
        await res.body?.cancel();   // 不消费 body，省流量

        if (ct.includes('text/html')) {
            sendResponse({ ok: false, error: '被拦截（返回 HTML）' });
            return;
        }
        sendResponse({
            ok: true,
            cdnUrl: finalUrl,
            contentType: ct,
            contentLength: parseInt(cl) || 0,
        });
    } catch (err) {
        sendResponse({
            ok: false,
            error: err.name === 'AbortError' ? '解析超时' : err.message,
        });
    } finally {
        clearTimeout(timer);
    }
}
