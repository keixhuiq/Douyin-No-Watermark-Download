// popup.js v1.1.0
// 下载入口 + 设置。下载逻辑全部在 content.js，popup 只发消息。
(function () {
    const DEFAULTS = {
        filenameTpl: '{title}@{author}',
        quality: 'best',
        debug: false,
    };

    const $ = id => document.getElementById(id);

    // 版本号
    $('ver').textContent = 'v' + chrome.runtime.getManifest().version;

    // ===== 后台状态检测 =====
    function checkStatus() {
        const statusEl = $('status');
        const txt = statusEl.querySelector('.status-text');
        chrome.runtime.sendMessage({ action: 'ping' }, res => {
            if (chrome.runtime.lastError || !res?.ok) {
                statusEl.classList.remove('ok'); statusEl.classList.add('err');
                txt.textContent = '后台离线';
            } else {
                statusEl.classList.remove('err'); statusEl.classList.add('ok');
                txt.textContent = '已连接';
            }
        });
    }
    checkStatus();

    // ===== 当前作品检测 + 下载按钮 =====
    const DOUYIN_RE = /^https?:\/\/([^/]*\.)?douyin\.com\//;
    let activeTabId = null;

    function setPreviewState(msg, isErr) {
        $('ppBody').hidden = true;
        const st = $('ppState');
        st.hidden = false;
        st.textContent = msg;
        st.classList.toggle('err', !!isErr);
    }

    function showPostInfo(info) {
        $('ppState').hidden = true;
        const body = $('ppBody');
        body.hidden = false;

        let typeLabel, meta;
        if (info.type === 'image') {
            if (info.subType === 'video_collection') {
                typeLabel = '视频集';
                meta = `${info.clipCount} 个视频`;
            } else if (info.subType === 'mixed') {
                typeLabel = '图文+视频';
                meta = `${info.clipCount} 个视频 + ${info.imageCount} 张图片`;
            } else {
                typeLabel = '图文';
                meta = `${info.imageCount} 张图片`;
            }
        } else {
            typeLabel = '视频';
            meta = info.qualityCount > 0 ? `${info.qualityCount} 个画质可选` : '单一画质';
        }
        $('ppType').textContent = typeLabel;
        $('ppTitle').textContent = info.desc || '（无标题）';
        $('ppTitle').title = info.desc || '';
        $('ppMeta').textContent = (info.author ? `@${info.author} · ` : '') + meta;
    }

    async function detectCurrentPost() {
        let tab;
        try {
            [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        } catch (e) { /* fallthrough */ }

        if (!tab?.id || !DOUYIN_RE.test(tab.url || '')) {
            setPreviewState('请在抖音页面打开本弹窗', true);
            return;
        }
        activeTabId = tab.id;

        chrome.tabs.sendMessage(tab.id, { action: 'get_post_info' }, res => {
            if (chrome.runtime.lastError) {
                setPreviewState('未连接到页面，请刷新抖音页面后重试', true);
                return;
            }
            $('btnDownload').disabled = false;
            if (res?.ok && res.info) {
                showPostInfo(res.info);
            } else {
                setPreviewState('未检测到作品 — 等视频开始播放后重试');
            }
        });
    }
    detectCurrentPost();

    $('btnDownload').addEventListener('click', () => {
        if (!activeTabId) return;
        chrome.tabs.sendMessage(activeTabId, { action: 'trigger_download' }, () => {
            void chrome.runtime.lastError;   // 吞掉可能的报错，进度由页面 toast 展示
        });
        window.close();   // 关闭弹窗，让用户看到页面上的进度 toast
    });

    // ===== 设置加载 =====
    chrome.storage.sync.get(DEFAULTS, items => {
        const cfg = { ...DEFAULTS, ...items };
        $('quality').value = cfg.quality || 'best';
        $('filenameTpl').value = cfg.filenameTpl || DEFAULTS.filenameTpl;
        $('debug').checked = !!cfg.debug;
    });

    // ===== 通用控件绑定 =====
    function flashSaved(el) {
        if (!el) return;
        el.classList.add('saved');
        setTimeout(() => el.classList.remove('saved'), 600);
    }

    $('debug').addEventListener('change', e => {
        chrome.storage.sync.set({ debug: e.target.checked });
    });

    function debounce(fn, ms) {
        let t;
        return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    }

    const saveTpl = debounce(() => {
        const v = $('filenameTpl').value.trim() || DEFAULTS.filenameTpl;
        chrome.storage.sync.set({ filenameTpl: v }, () => flashSaved($('filenameTpl')));
    }, 400);
    $('filenameTpl').addEventListener('input', saveTpl);

    $('quality').addEventListener('change', e => {
        chrome.storage.sync.set({ quality: e.target.value }, () => flashSaved(e.target));
    });

    document.querySelectorAll('.chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const tpl = chip.dataset.tpl;
            $('filenameTpl').value = tpl;
            chrome.storage.sync.set({ filenameTpl: tpl }, () => flashSaved($('filenameTpl')));
        });
    });

    // ===== 链接 =====
    $('shortcutLink').addEventListener('click', (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });
    $('chromeDlSettings').addEventListener('click', (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: 'chrome://settings/downloads' });
    });

    // ===== 全部重置 =====
    $('resetAll').addEventListener('click', (e) => {
        e.preventDefault();
        if (!confirm('恢复所有设置为默认值？')) return;
        chrome.storage.sync.set(DEFAULTS, () => {
            $('quality').value = DEFAULTS.quality;
            $('filenameTpl').value = DEFAULTS.filenameTpl;
            $('debug').checked = DEFAULTS.debug;
        });
    });
})();
