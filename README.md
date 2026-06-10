# 抖音 无水印下载（v1.1.0）

在抖音网页版下载无水印的视频、图文和视频集。Chrome / Edge Manifest V3 扩展。

> 本目录是一个可直接加载的浏览器扩展目录，无需构建、打包或安装依赖。

姊妹扩展：[TikTok No-Watermark Downloader](../TikTok%20No-Watermark%20Downloader) — 共用同一套架构，差异在数据提取逻辑、CDN 域以及 TikTok 特有的视频/音频分离处理。

## 更新说明

### v1.1.0

- **下载入口改版**：移除页面悬浮按钮，下载入口改为扩展弹窗——打开弹窗可预览当前检测到的作品（类型/标题/作者/画质数），一键下载。页内 `Shift+D` 保留，并通过 `commands` API 新增可自定义的全局快捷键（默认 `Alt+Shift+D`，刻意与 TikTok 版的 `Alt+D` 错开避免同装冲突）。
- **修复 blob URL 过早失效**：下载触发后 blob URL 的回收从 30 秒延长到 5 分钟，避免用户在 Save As 弹框里停留较久导致下载失败。
- **DNR 规则收敛作用域**：Referer 改写规则新增 `initiatorDomains` 限定（仅抖音页面与扩展自身发起的请求），并去掉 `main_frame`/`sub_frame`。此前规则是全浏览器生效的，会改写正常访问飞书、西瓜等 ByteDance 系站点的 Referer。
- **从 TikTok 版回灌三项健壮性改进**：图集图片下载失败时自动尝试 `url_list`/`download_url_list` 里的所有 CDN 副本；content script 直接 fetch 被 CORS 拦截时自动切换到 background service worker 代取；blob 大小校验按文件类型设阈值（视频 10KB / 图片 1KB），避免把 CDN 错误页当成下载成功。
- **权限收敛**：去掉冗余的 `declarativeNetRequest` 权限。
- 扩展图标更换为应用图标（16/32/48/128 全尺寸）。

## 功能

- **无水印**：从抖音返回的接口数据中提取原始资源（视频走 `play_addr`，图片走 `:origin` tplv 模板），并通过 declarativeNetRequest 重写 Referer，绕过 CDN 403。
- **三种内容**：单视频、图文（多图）、视频集（图文里内嵌视频片段）都支持，混合作品也能下。
- **画质选择**：可选最高 / 次高 / 最低画质；最高画质链接失效时会自动降级重试。
- **弹窗下载入口**：点扩展图标打开弹窗，可预览当前检测到的作品并一键下载，设置与说明都在同一面板。
- **快捷键**：页内 `Shift + D`；全局快捷键默认 `Alt + Shift + D`，可在 `chrome://extensions/shortcuts` 自定义。
- **文件名模板**：支持 `{title} {author} {id} {date}` 占位符，几种常用模板一键应用。
- **保存位置**：下载时会弹出系统保存框，并自动记住上次保存位置（按 Chrome 自身行为，不强制创建子目录）。如果你在 `chrome://settings/downloads` 关闭了「下载前询问每个文件保存位置」，则会静默保存到默认位置。

## 目录结构

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | Chrome / Edge 扩展清单，使用 Manifest V3。 |
| `inject.js` | 以 MAIN world 注入，hook `JSON.parse` 和 `Response.prototype.json`，从抖音接口响应中拦截作品数据并缓存到页面上下文。 |
| `content.js` | 页面侧主逻辑，负责 Toast、当前作品识别和下载调度（多 URL fallback + CORS fallback）。 |
| `background.js` | Service worker，维护 Referer 重写规则（initiatorDomains 限定作用域）、解析抖音 CDN 重定向，并为 CORS 受限的 CDN 代取数据。 |
| `popup.html` / `popup.css` / `popup.js` | 下载入口 + 作品预览 + 设置面板。 |
| `style.css` | 注入到抖音页面的进度 Toast 样式。 |
| `icon16/32/48/128.png` | 扩展图标。 |

## 安装

1. 下载本仓库（Code → Download ZIP，或 `git clone`）。
2. 打开 `chrome://extensions/` 或 `edge://extensions/`，右上角打开「开发者模式」。
3. 点「加载已解压的扩展程序」，选择本目录。

更新：把仓库覆盖到原目录，在扩展页点一下扩展卡片右下角的刷新图标即可。

## 使用

打开任意抖音视频/图文页面（包括喜欢/收藏列表里打开的弹窗作品），按 `Shift + D`（或全局 `Alt + Shift + D`）即可下载；也可以点右上角扩展图标，在弹窗里预览作品并点「下载当前作品」。画质、文件名模板等设置和使用说明都在弹窗里。

## 工作原理

`inject.js` 运行在页面 MAIN world，用 hook 方式捕获抖音接口返回的作品数据。`content.js` 运行在扩展隔离环境中，通过 `postMessage` 查询缓存数据、识别当前作品，并用 fetch + blob + `<a download>` 触发下载。`background.js` 负责给抖音相关 CDN 请求改写 Referer，并解析重定向后的稳定资源地址。

## 隐私

- 不收集任何数据，不联网（除了你下载视频/图片时直连抖音 CDN）。
- 所有偏好仅存在你自己的 Chrome 同步存储中。
- 不向第三方服务器上传浏览记录、账号信息或下载记录。

## 已知限制

- 信息流（首页推荐）滚动时，"当前正在播放的视频"识别可能不准。建议先点开作品再下载。
- 抖音偶尔会更新接口结构；如果某天突然识别不到，多半是字段路径变了，欢迎提 PR。
- 仅在抖音网页版（`www.douyin.com`）测试过。

## 开发

代码无构建步骤，纯原生 JS。直接改完在扩展页刷新即可。

打开设置里的「调试日志」可以在 Console 看到详细的解析过程。
