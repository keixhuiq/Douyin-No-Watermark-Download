// popup.js
(function () {
    const DEFAULTS = {
        showFloatBtn: true,
        floatPos: { right: 24, bottom: 80 },
        filenameTpl: '{title}@{author}',
        quality: 'best',
        debug: false,
    };

    const $ = id => document.getElementById(id);

    // 版本号
    $('ver').textContent = 'v' + chrome.runtime.getManifest().version;

    // 后台状态检测
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

    // 加载配置
    chrome.storage.sync.get(DEFAULTS, items => {
        const cfg = { ...DEFAULTS, ...items };
        $('showFloatBtn').checked = !!cfg.showFloatBtn;
        $('quality').value = cfg.quality || 'best';
        $('filenameTpl').value = cfg.filenameTpl || DEFAULTS.filenameTpl;
        $('debug').checked = !!cfg.debug;
        updatePosInfo(cfg.floatPos);
    });

    function updatePosInfo(pos) {
        if (!pos || (pos.right === DEFAULTS.floatPos.right && pos.bottom === DEFAULTS.floatPos.bottom)) {
            $('posInfo').textContent = '直接在页面上拖动按钮即可调整';
        } else {
            $('posInfo').textContent = `当前位置：距右 ${Math.round(pos.right)}px，距下 ${Math.round(pos.bottom)}px`;
        }
    }

    // 监听 storage 变化（按钮被拖动后实时更新提示）
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        if (changes.floatPos) updatePosInfo(changes.floatPos.newValue);
    });

    function flashSaved(el) {
        if (!el) return;
        el.classList.add('saved');
        setTimeout(() => el.classList.remove('saved'), 600);
    }

    function bindToggle(id) {
        const el = $(id);
        el.addEventListener('change', () => {
            chrome.storage.sync.set({ [id]: el.checked });
        });
    }
    bindToggle('showFloatBtn');
    bindToggle('debug');

    function debounce(fn, ms) {
        let t;
        return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    }

    function bindText(id, opts = {}) {
        const el = $(id);
        const saver = debounce(() => {
            let v = el.value;
            if (opts.transform) v = opts.transform(v);
            chrome.storage.sync.set({ [id]: v }, () => flashSaved(el));
        }, 400);
        el.addEventListener('input', saver);
    }
    bindText('filenameTpl', {
        transform: v => v.trim() || DEFAULTS.filenameTpl,
    });

    $('quality').addEventListener('change', e => {
        chrome.storage.sync.set({ quality: e.target.value }, () => flashSaved(e.target));
    });

    // 文件名模板预设
    document.querySelectorAll('.chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const tpl = chip.dataset.tpl;
            $('filenameTpl').value = tpl;
            chrome.storage.sync.set({ filenameTpl: tpl }, () => flashSaved($('filenameTpl')));
        });
    });

    // 重置按钮位置
    $('resetPos').addEventListener('click', () => {
        chrome.storage.sync.set({ floatPos: { ...DEFAULTS.floatPos } });
        updatePosInfo(DEFAULTS.floatPos);
    });

    // 跳转到扩展快捷键设置
    $('shortcutLink').addEventListener('click', (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });

    // 跳转到 Chrome 下载设置
    $('chromeDlSettings').addEventListener('click', (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: 'chrome://settings/downloads' });
    });

    // 全部重置
    $('resetAll').addEventListener('click', (e) => {
        e.preventDefault();
        if (!confirm('恢复所有设置为默认值？')) return;
        chrome.storage.sync.set(DEFAULTS, () => {
            $('showFloatBtn').checked = DEFAULTS.showFloatBtn;
            $('quality').value = DEFAULTS.quality;
            $('filenameTpl').value = DEFAULTS.filenameTpl;
            $('debug').checked = DEFAULTS.debug;
            updatePosInfo(DEFAULTS.floatPos);
        });
    });
})();
