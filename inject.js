// inject.js v4.1 - MAIN world
// 改进：
//   1. 精确匹配 :origin tplv 模板（避免误中含 "origin" 子串的 URL）
//   2. 同时 hook JSON.parse 和 Response.prototype.json（覆盖 fetch 路径）
//   3. videoStore 加 LRU 上限，防止信息流长时间累积
//   4. scanForVideos 深度限制一致化
(function () {
    'use strict';

    const STORE_MAX = 300;            // 缓存上限
    const SCAN_MAX_DEPTH = 6;         // 扫描最大深度

    const videoStore = new Map();     // 用 Map 维持插入顺序，便于 LRU 淘汰
    let latestId = '';
    const _parse = JSON.parse;
    const _respJson = Response.prototype.json;

    function storeSet(id, data) {
        // LRU：已存在则刷新到末尾；满了则删最早的
        if (videoStore.has(id)) videoStore.delete(id);
        else if (videoStore.size >= STORE_MAX) {
            const first = videoStore.keys().next().value;
            videoStore.delete(first);
        }
        videoStore.set(id, data);
        latestId = id;
    }

    function getPlayUrl(video) {
        if (!video) return '';
        if (video.play_addr && video.play_addr.url_list && video.play_addr.url_list.length > 0) {
            return video.play_addr.url_list[0];
        }
        if (video.playApi) return video.playApi;
        return '';
    }

    function getBitRates(video) {
        const list = video.bit_rate || video.bitRateList || [];
        const result = [];
        for (let i = 0; i < list.length; i++) {
            const br = list[i];
            let urls = [];
            if (br.play_addr && br.play_addr.url_list) urls = br.play_addr.url_list;
            else if (br.playApi) urls = [br.playApi];
            if (urls.length > 0) {
                const w = (br.play_addr && br.play_addr.width) || 0;
                const h = (br.play_addr && br.play_addr.height) || 0;
                result.push({
                    playApi: urls[0],
                    allUrls: urls,
                    quality: br.quality_type || br.gear_name || '',
                    bitRate: br.bit_rate || br.bitrate || 0,
                    width: w,
                    height: h,
                    pixels: w * h,
                });
            }
        }
        result.sort((a, b) => {
            if (a.bitRate !== b.bitRate) return b.bitRate - a.bitRate;
            return b.pixels - a.pixels;
        });
        return result;
    }

    // 选择无水印图片 URL
    // 抖音图片 URL tplv 模板示例：
    //   ~tplv-dy-aweme-images:q75.webp        无水印质量版
    //   ~tplv-dy-aweme-images-v6:origin.webp  无水印原图
    //   ~tplv-...:watermark...                有水印
    // 优先级：明确 :origin > 不含 watermark 的 url_list 项 > download_url_list 项
    const RE_TPLV_ORIGIN = /[~/]tplv-[^/?]*:origin/i;
    const RE_WATERMARK = /watermark/i;

    function pickBestImageUrl(img) {
        const urlList = img.url_list || [];
        const dlList = img.download_url_list || [];

        // 1) 优先找带 :origin 的 tplv 模板（明确的无水印原图）
        for (const u of urlList) {
            if (u && RE_TPLV_ORIGIN.test(u) && !RE_WATERMARK.test(u)) return u;
        }

        // 2) url_list 中不含 watermark 的
        for (const u of urlList) {
            if (u && !RE_WATERMARK.test(u)) return u;
        }

        // 3) 回退到 url_list 最后一项
        if (urlList.length > 0 && urlList[urlList.length - 1]) {
            return urlList[urlList.length - 1];
        }

        // 4) 最后回退 download_url_list（可能带水印，但聊胜于无）
        for (const u of dlList) {
            if (u && !RE_WATERMARK.test(u)) return u;
        }
        if (dlList.length > 0) return dlList[dlList.length - 1];

        return '';
    }

    // 提取图文作品的内容（图片 + 内嵌视频）
    function extractImagePost(item) {
        const result = { images: [], clipVideos: [] };

        const imgSources = item.images
            || (item.image_post_info && item.image_post_info.images)
            || [];

        for (let i = 0; i < imgSources.length; i++) {
            const img = imgSources[i];
            if (!img) continue;

            const embeddedVideo = img.video || (img.clip && img.clip.video) || null;

            if (embeddedVideo && (embeddedVideo.play_addr || embeddedVideo.playApi || embeddedVideo.bit_rate)) {
                result.clipVideos.push({
                    index: i,
                    playApi: getPlayUrl(embeddedVideo),
                    bitRateList: getBitRates(embeddedVideo),
                    coverUrl: pickBestImageUrl(img),
                    width: (embeddedVideo.play_addr && embeddedVideo.play_addr.width) || embeddedVideo.width || 0,
                    height: (embeddedVideo.play_addr && embeddedVideo.play_addr.height) || embeddedVideo.height || 0,
                });
            } else {
                const url = pickBestImageUrl(img);
                if (url) {
                    result.images.push({
                        index: i,
                        url,
                        allUrls: (img.url_list || []).concat(img.download_url_list || []),
                        width: img.width || 0,
                        height: img.height || 0,
                    });
                }
            }
        }

        return result;
    }

    function getAwemeType(item) {
        const t = item.aweme_type;
        if (t === 68 || t === 150) return 'image';
        if (item.images && item.images.length > 0) return 'image';
        if (item.image_post_info && item.image_post_info.images && item.image_post_info.images.length > 0) return 'image';
        return 'video';
    }

    function processVideoItem(item) {
        if (!item) return;
        const id = String(item.aweme_id || item.awemeId || item.id || '');
        if (!id) return;
        if (!item.video && !item.images && !item.image_post_info) return;

        const type = getAwemeType(item);
        const data = {
            awemeId: id,
            type,
            desc: item.desc || '',
            author: (item.author && item.author.nickname) || '',
        };

        if (type === 'image') {
            const extracted = extractImagePost(item);
            data.images = extracted.images;
            data.clipVideos = extracted.clipVideos;

            if (extracted.clipVideos.length > 0 && extracted.images.length === 0) {
                data.subType = 'video_collection';
            } else if (extracted.clipVideos.length > 0 && extracted.images.length > 0) {
                data.subType = 'mixed';
            } else {
                data.subType = 'pure_image';
            }

            if (item.video) {
                data.playApi = getPlayUrl(item.video);
                data.bitRateList = getBitRates(item.video);
            }
        } else {
            data.playApi = getPlayUrl(item.video);
            data.bitRateList = getBitRates(item.video);
        }

        storeSet(id, data);
        window.postMessage({ type: '__DY_DL_VIDEO_DATA__', data }, '*');
    }

    function scanForVideos(obj, depth) {
        if (depth > SCAN_MAX_DEPTH || !obj || typeof obj !== 'object') return;

        if ((obj.video || obj.images || obj.image_post_info) &&
            (obj.aweme_id || obj.awemeId || obj.id)) {
            processVideoItem(obj);
            return;
        }
        if (obj.aweme_detail) processVideoItem(obj.aweme_detail);
        if (Array.isArray(obj.aweme_list)) {
            for (const it of obj.aweme_list) processVideoItem(it);
        }

        const iter = Array.isArray(obj) ? obj : Object.keys(obj);
        for (let k = 0; k < iter.length; k++) {
            const key = Array.isArray(obj) ? k : iter[k];
            try {
                const val = obj[key];
                if (val && typeof val === 'object') scanForVideos(val, depth + 1);
            } catch (e) { /* ignore getter errors */ }
        }
    }

    // Hook JSON.parse
    JSON.parse = function () {
        const result = _parse.apply(this, arguments);
        try {
            if (result && typeof result === 'object') scanForVideos(result, 0);
        } catch (e) { /* swallow */ }
        return result;
    };

    // Hook Response.prototype.json — 覆盖 fetch().then(r => r.json()) 路径
    // 某些浏览器/版本下 Response.json 不走 JSON.parse
    Response.prototype.json = function () {
        return _respJson.call(this).then(data => {
            try {
                if (data && typeof data === 'object') scanForVideos(data, 0);
            } catch (e) { /* swallow */ }
            return data;
        });
    };

    // 查询接口
    window.addEventListener('message', function (e) {
        if (!e.data) return;
        if (e.data.type === '__DY_DL_QUERY__') {
            const tid = e.data.awemeId || '';
            let result = null;
            if (tid && videoStore.has(tid)) result = videoStore.get(tid);
            else if (latestId && videoStore.has(latestId)) result = videoStore.get(latestId);
            window.postMessage({
                type: '__DY_DL_QUERY_RESP__',
                data: result,
                storeSize: videoStore.size,
                latestId,
            }, '*');
        }
    });

    function scanRenderData() {
        try {
            const el = document.querySelector('script#RENDER_DATA');
            if (!el) return;
            const data = _parse(decodeURIComponent(el.textContent));
            if (data) scanForVideos(data, 0);
        } catch (e) { /* swallow */ }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(scanRenderData, 100));
    } else {
        setTimeout(scanRenderData, 100);
    }

    console.log('[DY-DL] inject.js v4.1 loaded');
})();
