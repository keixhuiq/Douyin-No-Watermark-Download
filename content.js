// content.js v1.1.0 - 抖音无水印下载
//
// v1.1.0 变更：
//   1. 移除页面悬浮按钮，下载入口改为扩展弹窗 UI + 快捷键
//      （页内 Shift+D 保留；新增 commands 全局快捷键，默认 Alt+Shift+D
//       —— 与 TikTok 版的 Alt+D 错开，避免同装时冲突）
//   2. blob URL 延迟 5 分钟再 revoke（30 秒太短，Save As 弹框停留超时会丢下载）
//   3. 从 TikTok 版回灌：图片多 URL 回退、background fetch_blob CORS 兜底、
//      按文件类型的 blob 大小校验
//
// 原有特性：
//   1. fetch + blob + <a download> 触发下载，Save As 弹框能记住上次位置
//   2. 画质 URL 失效时按 bitRate 顺序自动降级
//   3. 图片/视频统一走 background.js 解析 CDN 重定向
//   4. 文件名 sanitize 修正 emoji 截断、Windows 保留名
//   5. resolveUrl + sendMessage 都加超时
//   6. 实时下载进度提示
(function () {
    'use strict';

    // ===== 默认配置（与 popup.html 中的字段一致） =====
    const DEFAULTS = Object.freeze({
        filenameTpl: '{title}@{author}',        // {title} {author} {id} {date}
        quality: 'best',                         // best | second | lowest
        debug: false,
    });

    let CFG = { ...DEFAULTS };

    function loadConfig() {
        return new Promise(resolve => {
            chrome.storage.sync.get(DEFAULTS, items => {
                CFG = { ...DEFAULTS, ...items };
                resolve();
            });
        });
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        for (const k of Object.keys(changes)) {
            if (k in CFG) CFG[k] = changes[k].newValue ?? DEFAULTS[k];
        }
    });

    function log(...args) { if (CFG.debug) console.log('[DY-DL]', ...args); }
    function warn(...args) { console.warn('[DY-DL]', ...args); }

    // ===== 通用工具 =====

    function showToast(msg, duration = 3000) {
        document.querySelectorAll('.dy-dl-toast').forEach(el => el.remove());
        const el = document.createElement('div');
        el.className = 'dy-dl-toast';
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, duration);
    }

    // Windows 保留名
    const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

    function sanitize(name) {
        if (!name) return '';
        let s = name.replace(/[\\/:*?"<>|\n\r\t]/g, '_');
        // 用 Array.from 拆 surrogate pair，避免截断 emoji
        const chars = Array.from(s);
        if (chars.length > 60) s = chars.slice(0, 60).join('');
        s = s.replace(/[.\s]+$/, '').trim();  // 去掉末尾点号/空格（Windows 不允许）
        if (RESERVED.test(s)) s = '_' + s;
        return s;
    }

    function toFullUrl(p) {
        if (!p || typeof p !== 'string') return null;
        if (p.startsWith('http')) return p;
        if (p.startsWith('//')) return 'https:' + p;
        if (p.startsWith('/')) return 'https://www.douyin.com' + p;
        return null;
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function todayStr() {
        const d = new Date();
        const z = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}`;
    }

    // ===== 数据缓存 =====

    const videoDataMap = new Map();

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        if (event.data?.type === '__DY_DL_VIDEO_DATA__' && event.data.data) {
            const d = event.data.data;
            if (!d.awemeId) return;
            // LRU
            if (videoDataMap.has(d.awemeId)) videoDataMap.delete(d.awemeId);
            else if (videoDataMap.size >= 300) {
                videoDataMap.delete(videoDataMap.keys().next().value);
            }
            videoDataMap.set(d.awemeId, d);

            if (CFG.debug) {
                if (d.type === 'image') {
                    const label = d.subType === 'video_collection' ? '视频集'
                        : d.subType === 'mixed' ? '图文+视频' : '图文';
                    log(`✓ ${label}:`, d.awemeId,
                        `图片:${d.images?.length || 0}`,
                        `视频:${d.clipVideos?.length || 0}`,
                        d.desc?.substring(0, 25));
                } else {
                    log('✓ 视频:', d.awemeId, `画质数:${d.bitRateList?.length || 0}`, d.desc?.substring(0, 25));
                }
            }
        }
    });

    // ===== 画质选择 =====

    function pickQualityIndex(list) {
        if (!list || list.length === 0) return -1;
        if (CFG.quality === 'lowest') return list.length - 1;
        if (CFG.quality === 'second' && list.length >= 2) return 1;
        return 0;
    }

    // 返回按偏好排序的 URL 列表，用于失败时降级
    function getCandidateVideoUrls(data) {
        const urls = [];
        if (data?.bitRateList?.length) {
            const startIdx = pickQualityIndex(data.bitRateList);
            // 从偏好画质开始，依次往后尝试，再绕回前面
            const ordered = [
                ...data.bitRateList.slice(startIdx),
                ...data.bitRateList.slice(0, startIdx),
            ];
            for (const br of ordered) {
                if (br.playApi) {
                    const u = toFullUrl(br.playApi);
                    if (u && !urls.includes(u)) urls.push(u);
                }
                for (const alt of (br.allUrls || [])) {
                    const u = toFullUrl(alt);
                    if (u && !urls.includes(u)) urls.push(u);
                }
            }
        }
        if (data?.playApi) {
            const u = toFullUrl(data.playApi);
            if (u && !urls.includes(u)) urls.push(u);
        }
        return urls;
    }

    // ===== 当前作品识别 =====

    function getVidFromUrl() {
        let m = location.href.match(/\/video\/(\d+)/); if (m) return m[1];
        m = location.href.match(/modal_id=(\d+)/); if (m) return m[1];
        m = location.href.match(/note\/(\d+)/); if (m) return m[1];
        return null;
    }

    function findActiveVideo() {
        const videos = document.querySelectorAll('video');
        let best = null, bestArea = 0;
        for (const v of videos) {
            const r = v.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const area = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0))
                * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
            if (area > bestArea) { bestArea = area; best = v; }
        }
        return best;
    }

    function findVideoContainer(videoEl) {
        let el = videoEl;
        for (let i = 0; i < 15 && el; i++) {
            el = el.parentElement;
            if (!el) break;
            const awemeId = el.getAttribute('data-aweme-id') || el.dataset?.awemeId;
            if (awemeId) return { awemeId };
            const link = el.querySelector('a[href*="/video/"], a[href*="/note/"]');
            if (link) {
                const m = link.href.match(/\/(?:video|note)\/(\d+)/);
                if (m) return { awemeId: m[1] };
            }
        }
        return { awemeId: null };
    }

    function findByVisibleText() {
        const selectors = [
            '[data-e2e="video-desc"]', '[class*="videoDesc"]',
            '[class*="video-desc"]', '[class*="titleText"]',
        ];
        for (const sel of selectors) {
            for (const el of document.querySelectorAll(sel)) {
                const r = el.getBoundingClientRect();
                if (r.top < innerHeight && r.bottom > 0 && r.width > 0) {
                    const text = el.textContent?.trim();
                    if (text?.length > 3) {
                        for (const [, data] of videoDataMap) {
                            if (!data.desc || data.desc.length < 5) continue;
                            // 提高阈值：整段包含，或者高重合度
                            if (text.includes(data.desc) || data.desc.includes(text)) return data;
                            const parts = data.desc.split(/[#@\s，。！？、]+/).filter(p => p.length >= 4);
                            let score = 0;
                            for (const p of parts) { if (text.includes(p)) score += p.length; }
                            if (score >= 10) return data;
                        }
                    }
                }
            }
        }
        return null;
    }

    function queryInject(awemeId) {
        return new Promise((resolve) => {
            const handler = (event) => {
                if (event.data?.type === '__DY_DL_QUERY_RESP__') {
                    window.removeEventListener('message', handler);
                    clearTimeout(timer);
                    resolve(event.data);
                }
            };
            window.addEventListener('message', handler);
            const timer = setTimeout(() => {
                window.removeEventListener('message', handler);
                resolve(null);
            }, 500);
            window.postMessage({ type: '__DY_DL_QUERY__', awemeId: awemeId || '' }, '*');
        });
    }

    async function getCurrentData() {
        const vid = getVidFromUrl();
        log('--- 开始获取 ---', 'URL ID:', vid || '无', '| 缓存:', videoDataMap.size);

        if (vid && videoDataMap.has(vid)) { log('✓ URL ID 命中'); return videoDataMap.get(vid); }

        const activeVideo = findActiveVideo();
        if (activeVideo) {
            const { awemeId } = findVideoContainer(activeVideo);
            if (awemeId && videoDataMap.has(awemeId)) { log('✓ DOM ID:', awemeId); return videoDataMap.get(awemeId); }
        }

        const textMatch = findByVisibleText();
        if (textMatch) { log('✓ 文字匹配'); return textMatch; }

        const resp = await queryInject(vid);
        if (resp?.data) { log('✓ inject.js'); return resp.data; }

        return null;
    }

    // ===== 与 service worker 通信（带超时） =====

    function sendMessage(payload, timeout = 20000) {
        return new Promise(resolve => {
            let done = false;
            const finish = (val) => { if (done) return; done = true; resolve(val); };
            const timer = setTimeout(() => finish({ ok: false, error: '后台无响应' }), timeout);
            try {
                chrome.runtime.sendMessage(payload, res => {
                    clearTimeout(timer);
                    if (chrome.runtime.lastError) {
                        finish({ ok: false, error: chrome.runtime.lastError.message });
                    } else {
                        finish(res || { ok: false, error: '空响应' });
                    }
                });
            } catch (e) {
                clearTimeout(timer);
                finish({ ok: false, error: e.message });
            }
        });
    }

    function resolveUrl(url) {
        return sendMessage({ action: 'resolve_url', url }, 18000);
    }

    // ===== 触发浏览器原生下载 =====
    // 用 fetch → blob → <a download> 的方式触发，让浏览器把这当作"用户主动下载"
    // 优点：Save As 弹框会记住上次的保存位置
    // 缺点：整个文件先读到内存里再保存。抖音视频通常 5-50MB，可以接受。
    function triggerBrowserDownload(blob, filename) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        // 给用户在 Save As 弹框里挑目录留足时间，过早 revoke 会让下载失败
        setTimeout(() => {
            a.remove();
            URL.revokeObjectURL(a.href);
        }, 5 * 60 * 1000);
    }

    // 带进度的 fetch 下载
    // onProgress(loaded, total) 可能多次调用；total 为 0 时表示未知
    // opts.credentials: 默认 'omit'（抖音 CDN 不需要 cookie，且 omit 可避免
    // ACAO: * 与 credentials 的 CORS 冲突）
    async function fetchWithProgress(url, onProgress, opts = {}) {
        const ctrl = new AbortController();
        const res = await fetch(url, {
            credentials: opts.credentials || 'omit',
            signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const ct = res.headers.get('Content-Type') || '';
        if (ct.includes('text/html')) throw new Error('被拦截（返回 HTML）');

        const total = parseInt(res.headers.get('Content-Length') || '0', 10);

        // 没有 ReadableStream 时退化到 res.blob()
        if (!res.body || !res.body.getReader) {
            const blob = await res.blob();
            if (onProgress) onProgress(blob.size, blob.size);
            return { blob, total: blob.size, contentType: ct };
        }

        const reader = res.body.getReader();
        const chunks = [];
        let loaded = 0;
        let lastTick = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.length;
            const now = Date.now();
            if (onProgress && now - lastTick > 200) {
                onProgress(loaded, total);
                lastTick = now;
            }
        }
        if (onProgress) onProgress(loaded, total);
        const blob = new Blob(chunks, { type: ct || 'application/octet-stream' });
        return { blob, total: loaded, contentType: ct };
    }

    // 通过 background service worker fetch（绕过 CORS，从 TikTok 版回灌）
    // 抖音 CDN 偶发不返回 CORS 头，content script 直接 fetch 会被拦截
    async function bgFetchBlob(url, opts = {}) {
        const res = await sendMessage({
            action: 'fetch_blob',
            url,
            credentials: opts.credentials || 'omit',
        }, 70000);
        if (!res?.ok) throw new Error(res?.error || 'background fetch failed');
        return {
            blob: new Blob([res.buffer], { type: res.contentType || 'application/octet-stream' }),
            total: res.size,
            contentType: res.contentType,
        };
    }

    // 只 fetch 拿 blob，不触发保存。直接 fetch 疑似被 CORS 拦截时走 background 兜底。
    async function fetchOne(cdnUrl, label, opts = {}) {
        try {
            return await fetchWithProgress(cdnUrl, (loaded, total) => {
                const mb = (loaded / 1048576).toFixed(1);
                if (total > 0) {
                    const pct = Math.round((loaded / total) * 100);
                    const totalMB = (total / 1048576).toFixed(1);
                    showToast(`⏬ ${label} ${pct}% (${mb}/${totalMB}MB)`, 2000);
                } else {
                    showToast(`⏬ ${label} ${mb}MB`, 2000);
                }
            }, opts);
        } catch (err) {
            const msg = err?.message || '';
            const isCorsLikely = msg.includes('Failed to fetch') || msg.includes('CORS') || msg.includes('NetworkError');
            if (!isCorsLikely) {
                warn(`${label} 下载失败:`, msg);
                return null;
            }
            log(`${label}: 直接 fetch 被拦截（疑似 CORS），改走 background...`);
            showToast(`⏬ ${label} 切换通道重试...`, 2000);
            try {
                return await bgFetchBlob(cdnUrl, opts);
            } catch (err2) {
                warn(`${label} background 兜底也失败:`, err2.message);
                return null;
            }
        }
    }

    // 按文件类型设置最小合法大小（从 TikTok 版回灌）：
    // 统一 100B 的旧阈值会把 CDN 返回的错误页当成"下载成功的视频"
    function validateBlobSize(blob, filename, label) {
        const isVideo = filename.endsWith('.mp4');
        const minSize = isVideo ? 10000 : 1000;
        if (blob.size < minSize) {
            warn(`${label}: 文件太小 (${blob.size}B)，疑似失败`);
            return false;
        }
        return true;
    }

    // 下载一个资源（图片/视频通用），label 用于 toast 提示
    async function downloadOne(cdnUrl, filename, label, opts = {}) {
        const result = await fetchOne(cdnUrl, label, opts);
        if (!result) return false;
        if (!validateBlobSize(result.blob, filename, label)) return false;
        triggerBrowserDownload(result.blob, filename);
        log(`✅ ${filename} ${(result.blob.size / 1048576).toFixed(1)}MB`);
        return true;
    }

    // ===== 文件名生成 =====

    function guessImageExt(url) {
        if (/\.webp(\?|$)|format=webp/i.test(url)) return '.webp';
        if (/\.png(\?|$)|format=png/i.test(url)) return '.png';
        return '.jpg';
    }

    function makePrefix(data) {
        const tpl = CFG.filenameTpl || DEFAULTS.filenameTpl;
        const title = sanitize(data.desc) || '抖音';
        const author = sanitize(data.author) || '';
        const id = data.awemeId || '';
        const date = todayStr();

        let s = tpl
            .replace(/\{title\}/g, title)
            .replace(/\{author\}/g, author)
            .replace(/\{id\}/g, id)
            .replace(/\{date\}/g, date);

        // 收尾：去掉模板替换后留下的空连接符
        s = s.replace(/@(?=[\/_\-.\s]|$)/g, '')   // 空 author 后留下的 @
             .replace(/[_\-]{2,}/g, '_')
             .replace(/^[_\-@.\s]+|[_\-@.\s]+$/g, '');
        return s || '抖音';
    }

    // ===== 下载主流程 =====

    async function triggerDownload() {
        showToast('⏬ 获取作品信息...');
        const data = await getCurrentData();
        if (!data) { showToast('❌ 未检测到作品，请稍候再试'); return; }

        const prefix = makePrefix(data);
        log('文件名前缀:', prefix);

        if (data.type === 'image') {
            const clipVideos = data.clipVideos || [];
            const images = data.images || [];

            if (clipVideos.length > 0) {
                await downloadClipVideos(clipVideos, images, prefix);
            } else if (images.length > 0) {
                await downloadPureImages(images, prefix);
            } else {
                showToast('❌ 未找到图片或视频数据');
            }
        } else {
            await downloadSingleVideo(data, prefix);
        }
    }

    // ===== 视频：尝试多个候选 URL 直到成功 =====

    async function downloadVideoWithFallback(data, filename, label) {
        const candidates = getCandidateVideoUrls(data);
        if (candidates.length === 0) {
            showToast(`❌ ${label}：无可用链接`);
            return false;
        }

        for (let i = 0; i < candidates.length; i++) {
            const url = candidates[i];
            showToast(`⏬ ${label} 解析中${i > 0 ? `（重试 ${i}）` : ''}...`);
            const res = await resolveUrl(url);
            if (res?.ok && res.cdnUrl) {
                const sizeMB = (res.contentLength / 1048576).toFixed(1);
                log(`${label}: ${sizeMB}MB`, res.cdnUrl.substring(0, 80));
                const ok = await downloadOne(res.cdnUrl, filename, label);
                if (ok) return true;
            } else {
                warn(`${label} 解析失败:`, res?.error);
            }
        }
        showToast(`❌ ${label}：全部链接均失败`);
        return false;
    }

    async function downloadSingleVideo(data, prefix) {
        const filename = `${prefix}.mp4`;
        const ok = await downloadVideoWithFallback(data, filename, '视频');
        if (ok) showToast('✅ ' + filename);
    }

    async function downloadClipVideos(clipVideos, images, prefix) {
        const total = clipVideos.length + images.length;
        showToast(`⏬ ${clipVideos.length} 个视频${images.length > 0 ? ` + ${images.length} 张图片` : ''}`);
        let ok = 0;
        let idx = 0;

        for (let i = 0; i < clipVideos.length; i++) {
            idx++;
            const clip = clipVideos[i];
            const filename = `${prefix}_${String(idx).padStart(2, '0')}.mp4`;
            const success = await downloadVideoWithFallback(clip, filename, `视频 ${idx}/${total}`);
            if (success) ok++;
            if (i < clipVideos.length - 1 || images.length > 0) await sleep(500);
        }

        for (let i = 0; i < images.length; i++) {
            idx++;
            const img = images[i];
            const url = toFullUrl(img.url);
            if (!url) continue;

            const ext = guessImageExt(url);
            const filename = `${prefix}_${String(idx).padStart(2, '0')}${ext}`;
            const allUrls = (img.allUrls || []).map(toFullUrl).filter(Boolean);
            const success = await downloadImage(url, allUrls, filename, `图片 ${idx}/${total}`);
            if (success) ok++;
            if (i < images.length - 1) await sleep(300);
        }

        showToast(ok > 0 ? `✅ 完成: ${ok}/${total}` : '❌ 全部失败');
    }

    async function downloadPureImages(images, prefix) {
        showToast(`⏬ 下载 ${images.length} 张图片...`);
        let ok = 0;

        for (let i = 0; i < images.length; i++) {
            const img = images[i];
            const url = toFullUrl(img.url);
            if (!url) continue;

            const ext = guessImageExt(url);
            const filename = `${prefix}_${String(i + 1).padStart(2, '0')}${ext}`;
            const allUrls = (img.allUrls || []).map(toFullUrl).filter(Boolean);
            const success = await downloadImage(url, allUrls, filename, `图片 ${i + 1}/${images.length}`);
            if (success) ok++;
            if (i < images.length - 1) await sleep(300);
        }

        showToast(ok > 0 ? `✅ 完成: ${ok}/${images.length} 张图片` : '❌ 图片下载失败');
    }

    // 图片下载：依次尝试主 URL + 所有备选 URL（url_list/download_url_list 里
    // 通常有多个 CDN 副本，从 TikTok 版回灌的多 URL 回退）
    // 每个候选先 resolveUrl 处理重定向，再 fetch+blob 下载
    async function downloadImage(primaryUrl, allUrls, filename, label) {
        const candidates = [primaryUrl];
        for (const u of (allUrls || [])) {
            if (u && !candidates.includes(u)) candidates.push(u);
        }
        for (const url of candidates) {
            const res = await resolveUrl(url);
            const finalUrl = (res?.ok && res.cdnUrl) ? res.cdnUrl : url;
            const ok = await downloadOne(finalUrl, filename, label);
            if (ok) return true;
        }
        return false;
    }

    // ===== 下载入口：弹窗 UI / 全局快捷键 / 页内快捷键 =====
    // v1.1.0 起不再有页面悬浮按钮，触发路径：
    //   1) popup「下载当前作品」按钮 → trigger_download 消息
    //   2) commands 全局快捷键（默认 Alt+Shift+D，chrome://extensions/shortcuts 可改）
    //      → background → trigger_download 消息
    //   3) 页内 Shift+D（仅页面聚焦时有效）

    let downloading = false;

    function safeTriggerDownload() {
        if (downloading) { showToast('⏳ 正在下载中…'); return; }
        downloading = true;
        triggerDownload()
            .catch(err => { warn('异常:', err); showToast('❌ ' + err.message); })
            .finally(() => { downloading = false; });
    }

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg?.action === 'trigger_download') {
            safeTriggerDownload();
            sendResponse({ ok: true });
            return false;
        }
        // popup 打开时查询当前作品信息，用于预览
        if (msg?.action === 'get_post_info') {
            getCurrentData().then(data => {
                if (!data) { sendResponse({ ok: false }); return; }
                sendResponse({
                    ok: true,
                    info: {
                        awemeId: data.awemeId,
                        type: data.type,
                        subType: data.subType || null,
                        desc: data.desc || '',
                        author: data.author || '',
                        imageCount: data.images?.length || 0,
                        clipCount: data.clipVideos?.length || 0,
                        qualityCount: data.bitRateList?.length || 0,
                    },
                });
            }).catch(() => sendResponse({ ok: false }));
            return true;   // 异步 sendResponse
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.shiftKey && (e.key === 'D' || e.key === 'd')) {
            const t = document.activeElement?.tagName?.toLowerCase();
            if (t === 'input' || t === 'textarea' || document.activeElement?.contentEditable === 'true') return;
            e.preventDefault();
            safeTriggerDownload();
        }
    });

    async function init() {
        await loadConfig();
        log('v1.1.0 已加载 | 配置:', CFG);
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        window.addEventListener('DOMContentLoaded', init);
    }
})();
