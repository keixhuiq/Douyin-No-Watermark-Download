// content.js - 抖音无水印下载
//   1. 悬浮按钮可拖动 + 位置持久化 + 可由 popup 隐藏
//   2. 用 fetch + blob + <a download> 触发下载，Save As 弹框能记住上次位置
//   3. 画质 URL 失效时按 bitRate 顺序自动降级
//   4. 图片/视频统一走 background.js 解析 CDN 重定向
//   5. 文件名 sanitize 修正 emoji 截断、Windows 保留名
//   6. resolveUrl + sendMessage 都加超时
//   7. 实时下载进度提示
(function () {
    'use strict';

    // ===== 默认配置（与 popup.html 中的字段一致） =====
    const DEFAULTS = Object.freeze({
        showFloatBtn: true,
        floatPos: { right: 24, bottom: 80 },   // 距右下角的偏移
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
        applyButtonVisibility();
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
        setTimeout(() => {
            a.remove();
            URL.revokeObjectURL(a.href);
        }, 30000);
    }

    // 带进度的 fetch 下载
    // onProgress(loaded, total) 可能多次调用；total 为 0 时表示未知
    async function fetchWithProgress(url, onProgress) {
        const ctrl = new AbortController();
        const res = await fetch(url, {
            credentials: 'omit',
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

    // 下载一个资源（图片/视频通用），label 用于 toast 提示
    async function downloadOne(cdnUrl, filename, label) {
        try {
            const { blob } = await fetchWithProgress(cdnUrl, (loaded, total) => {
                const mb = (loaded / 1048576).toFixed(1);
                if (total > 0) {
                    const pct = Math.round((loaded / total) * 100);
                    const totalMB = (total / 1048576).toFixed(1);
                    showToast(`⏬ ${label} ${pct}% (${mb}/${totalMB}MB)`, 2000);
                } else {
                    showToast(`⏬ ${label} ${mb}MB`, 2000);
                }
            });
            if (blob.size < 100) {
                warn(`${label}: 文件太小 (${blob.size}B)，疑似失败`);
                return false;
            }
            triggerBrowserDownload(blob, filename);
            log(`✅ ${filename} ${(blob.size / 1048576).toFixed(1)}MB`);
            return true;
        } catch (err) {
            warn(`${label} 下载失败:`, err.message);
            return false;
        }
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
            const success = await downloadImage(url, filename, `图片 ${idx}/${total}`);
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
            const success = await downloadImage(url, filename, `图片 ${i + 1}/${images.length}`);
            if (success) ok++;
            if (i < images.length - 1) await sleep(300);
        }

        showToast(ok > 0 ? `✅ 完成: ${ok}/${images.length} 张图片` : '❌ 图片下载失败');
    }

    // 图片：先 resolveUrl 拿到最终 CDN URL（处理重定向），然后通过 fetch+blob 下载
    async function downloadImage(url, filename, label) {
        const res = await resolveUrl(url);
        const finalUrl = (res?.ok && res.cdnUrl) ? res.cdnUrl : url;
        return downloadOne(finalUrl, filename, label);
    }

    // ===== 悬浮按钮（可拖动） =====

    function clampPos(pos) {
        const minX = 8, minY = 8;
        const maxX = Math.max(minX, innerWidth - 58);
        const maxY = Math.max(minY, innerHeight - 58);
        return {
            right: Math.min(Math.max(pos.right ?? 24, minX), maxX),
            bottom: Math.min(Math.max(pos.bottom ?? 80, minY), maxY),
        };
    }

    function applyButtonPos(wrap) {
        const p = clampPos(CFG.floatPos || DEFAULTS.floatPos);
        wrap.style.right = p.right + 'px';
        wrap.style.bottom = p.bottom + 'px';
    }

    function applyButtonVisibility() {
        const wrap = document.getElementById('dy-dl-float');
        if (!wrap) return;
        wrap.style.display = CFG.showFloatBtn ? '' : 'none';
        applyButtonPos(wrap);
    }

    function createFloatButton() {
        if (document.getElementById('dy-dl-float')) return;
        const wrap = document.createElement('div');
        wrap.className = 'dy-dl-float';
        wrap.id = 'dy-dl-float';

        const btn = document.createElement('button');
        btn.className = 'dy-dl-float-btn';
        btn.innerHTML = '⬇';
        btn.title = '下载当前作品（无水印）\n拖动可移动位置\n快捷键: Shift+D';

        wrap.appendChild(btn);
        document.body.appendChild(wrap);
        applyButtonPos(wrap);
        applyButtonVisibility();

        // 拖动逻辑：按下后 5px 阈值才算拖动，否则当点击处理
        let down = null;
        let dragging = false;

        function onDown(e) {
            const pt = e.touches ? e.touches[0] : e;
            down = { x: pt.clientX, y: pt.clientY, r: parseFloat(wrap.style.right) || 24, b: parseFloat(wrap.style.bottom) || 80 };
            dragging = false;
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
            window.addEventListener('touchmove', onMove, { passive: false });
            window.addEventListener('touchend', onUp);
        }
        function onMove(e) {
            if (!down) return;
            const pt = e.touches ? e.touches[0] : e;
            const dx = pt.clientX - down.x;
            const dy = pt.clientY - down.y;
            if (!dragging && Math.hypot(dx, dy) < 5) return;
            dragging = true;
            if (e.cancelable) e.preventDefault();
            const np = clampPos({ right: down.r - dx, bottom: down.b - dy });
            wrap.style.right = np.right + 'px';
            wrap.style.bottom = np.bottom + 'px';
        }
        function onUp() {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            window.removeEventListener('touchmove', onMove);
            window.removeEventListener('touchend', onUp);
            if (dragging) {
                const pos = {
                    right: parseFloat(wrap.style.right) || 24,
                    bottom: parseFloat(wrap.style.bottom) || 80,
                };
                CFG.floatPos = pos;
                chrome.storage.sync.set({ floatPos: pos });
            }
            // 短延迟，避免拖动结束时的 click 误触
            setTimeout(() => { dragging = false; }, 50);
            down = null;
        }

        btn.addEventListener('mousedown', onDown);
        btn.addEventListener('touchstart', onDown, { passive: true });

        btn.addEventListener('click', (e) => {
            if (dragging) { e.preventDefault(); e.stopPropagation(); return; }
            btn.classList.add('loading');
            triggerDownload()
                .catch(err => { warn('异常:', err); showToast('❌ ' + err.message); })
                .finally(() => setTimeout(() => btn.classList.remove('loading'), 2000));
        });
    }

    document.addEventListener('keydown', (e) => {
        if (e.shiftKey && (e.key === 'D' || e.key === 'd')) {
            const t = document.activeElement?.tagName?.toLowerCase();
            if (t === 'input' || t === 'textarea' || document.activeElement?.contentEditable === 'true') return;
            e.preventDefault();
            triggerDownload();
        }
    });

    async function init() {
        await loadConfig();
        createFloatButton();
        log('v1.0.0 已加载 | 配置:', CFG);
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(init, 500);
    } else {
        window.addEventListener('DOMContentLoaded', () => setTimeout(init, 500));
    }

    // SPA 路由切换时，按钮可能被抖音清空，需要补回
    let lastUrl = location.href;
    new MutationObserver(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            setTimeout(() => {
                createFloatButton();
                applyButtonVisibility();
            }, 500);
        }
    }).observe(document.body, { childList: true, subtree: true });
})();
