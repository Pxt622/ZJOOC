# ZJOOC 智能刷课助手 v2.0

浙学网（zjooc.cn）课程视频自动播放用户脚本。

## 功能

- 视频自动播放（静音、后台不断）
- 视频倍速播放（0.5x ~ 16x，默认 2x）
- 自动静音播放
- 后台 / 切标签页不断播
- 自动跳转下一章节
- 图文章节自动计时跳过
- 右下角可折叠配置面板（实时控制）

## 安装

1. 安装浏览器扩展：Tampermonkey（Chrome/Edge）或 Greasemonkey（Firefox）
2. 打开扩展管理面板 → 新建脚本
3. 将 `zjooc-auto.user.js` 全部内容粘贴进去
4. `Ctrl+S` 保存
5. 访问浙学网课程学习页面即可自动启用

**自动匹配 URL（无需手动配置）：**
```
*://www.zjooc.cn/ucenter/student/course/study/*/plan/detail/*
```

## 使用

### 配置面板

页面右下角的蓝色 `[ZJOOC] ⚙` 按钮，点击展开面板：

- **倍速下拉框** — 选择播放速度（0.5x ~ 16x），即时生效
- **静音复选框** — 控制是否静音播放，即时生效
- **自动跳转复选框** — 关闭后视频播完不自动跳转
- **图文等待(秒)** — 图文章节等待多久后自动跳过（默认 10 秒）
- **\[开始\] / \[暂停\]** — 手动控制脚本运行状态
- **状态文字** — 显示当前运行状态

### 快捷键

向下展开面板后有「开始」「暂停」按钮，无键盘快捷键。

### 注意事项

- 默认倍速 **2x（安全倍速上限 4x）**，16x/8x 选项仅供 UI 参考，实际 `video.playbackRate` 受 `CONFIG.maxSpeed` 限制
- 切换标签页或最小化浏览器时视频不会暂停（防检测模块已覆盖 `document.hidden` / `visibilityState`）
- 脚本生效后有 `[ZJOOC]` 前缀的控制台日志

## 架构

### 状态机

脚本采用 **3 秒轮询状态机** 驱动，非事件驱动：

```
                  ┌─────────────────────────────────────────┐
                  │                                         │
                  ▼                                         │
    ┌──────┐  ┌──────┐  ┌────────────────┐  ┌──┐  ┌────┐  │
    │IDLE  ├─►│VIDEO ├─►│   NEXT         ├─►│   │  │    │  │
    │      │  │PLAY  │  │   (nextChapter)│  │NVG│  │DONE│  │
    │      │◄─│ING   │  │                │◄─│   │◄─┤    │  │
    └──────┘  └──────┘  └────────────────┘  └──┘  └────┘  │
       │                                                   │
       ▼                                                   │
    ┌────────────────┐  ┌─────────────────┐                │
    │   DOCUMENT     ├─►│    NEXT         ├────────────────┘
    │(图文/视频未加载)│  │(同层逻辑导航)    │
    └────────────────┘  └─────────────────┘
```

| 状态 | 描述 |
|------|------|
| `IDLE` | 初始状态。检查页面就绪 → 检查内容是否已完成 → 检查视频元素 → 进入 VIDEO_PLAYING 或 DOCUMENT |
| `VIDEO_PLAYING` | 视频播放中。监听结束事件、进度更新、卡住恢复 |
| `DOCUMENT` | 图文章节（无视频）或视频尚未加载。计时等待，超时后跳过 |
| `NEXT` | 执行章节导航逻辑（4 层降级策略），然后进入 NAVIGATING |
| `NAVIGATING` | 导航后等待新章节就绪。检测 video 元素出现后回到 IDLE |
| `COMPLETED` | 所有课程完成，终结 |

### 轮询间隔

主循环 `setInterval(main, 3000)`，每 3 秒执行一次。跳转后最快在下一个 tick（3 秒内）恢复播放。

### 8 个模块

| 模块 | 文件位置 | 职责 |
|------|----------|------|
| **CONFIG** | L27-40 | 可配置参数和速度映射表 |
| **LOGGER** | L51-56 | 统一 `[ZJOOC]` 前缀日志 |
| **ANTI_DETECT** | L62-85 | 防检测：禁止 `hidden`、`visibilityState`、定时模拟鼠标移动 |
| **SELECTORS** | L91-166 | DOM 查找：querySelector 优先 + 索引 fallback |
| **VIDEO** | L186-278 | 视频操控：播放、倍速、静音、进度的设置与读取 |
| **DOCUMENT** | L321-336 | 图文章节处理：点击"完成学习" + 计时等待 |
| **NAVIGATION** | L342-419 | 章节导航（4 层降级）与侧栏同步 |
| **UI_PANEL** | L425-590 | 右下角浮动配置面板的构建和交互 |
| **STATE_MAIN** | L596-754 | 状态机定义 + 主循环 |

### 4 层导航策略

在 `NEXT` 状态中按优先级依次尝试：

1. **同节内切标签** — 跳过前 2 个非视频标签（课程信息、讨论区），点击当前节的下一个视频标签
2. **同章内下一节** — 在当前子菜单（`el-submenu`）中找下一个菜单项点击
3. **下一章第一节** — 找下一个子菜单，点击其第一个菜单项
4. **全部完成** — 没有更多内容，进入 COMPLETED 状态

### DOM 选择器策略

脚本识别视频播放器的关键元素：

| 元素 | 定位方式 | 说明 |
|------|----------|------|
| `<video>` | `document.querySelector('video')` | 唯一的 video 元素 |
| 倍速按钮 | `video.parentNode.childNodes[2].children[13]` | 控制栏中的倍速按钮 |
| 倍速面板 | `document.querySelector('[class*="playbackratep"]')` | 弹出面板中的倍速选项 |
| 静音按钮 | `video.parentNode.childNodes[2].children[18]` | 控制栏中的静音按钮 |
| 中心播放覆盖层 | `video.parentNode.childNodes[10]` | 始终可见的播放/暂停按钮 |
| 进度文本 | `video.parentNode.childNodes[2].children[7]` | 如 "07:53 / 13:36" |
| 侧栏当前章节 | `.base-asider .el-menu-item.is-active` | ElementUI 侧边栏 |
| 侧栏当前子菜单 | `.base-asider .el-submenu.is-active` | ElementUI 子菜单 |
| 面包屑章节名 | `.plan-detail > .el-header > ul > li[0]` | 页面顶部面包屑 |
| 完成图标 (`tab`) | `.el-tabs__nav .is-active i.complete` | 标签页上的已完成标记 |

### 防检测机制

- 覆写 `document.hidden` → 始终返回 `false`
- 覆写 `document.visibilityState` → 始终返回 `'visible'`
- 每 30 秒向页面派发一次 `mousemove` 事件（`document.body` + `document.documentElement`）

### 播放恢复机制

- **轻量恢复**：视频播放进度卡住 3 秒以上 → 点击播放覆盖层 + 调用 `video.play()`
- **重量恢复**：轻量恢复无效后 1 秒 → 完整重设倍速、静音、播放（调用 `setupVideo()`）
- **播放被拦截**：`vid.play()` 被浏览器拒绝 → 1 秒后自动重试

## 日志

查看浏览器开发者工具（F12 → Console），过滤 `[ZJOOC]`：

```
[ZJOOC] 防检测模块已启动
[ZJOOC] 配置面板已就绪
[ZJOOC] ZJOOC 智能刷课助手 v2.0 已启动
[ZJOOC] 匹配页面: https://www.zjooc.cn/...
[ZJOOC] 播放中 2x
[ZJOOC] 跳转 - 同章下一节
[ZJOOC] 检测到图文章节，等待 10 秒后跳转
[ZJOOC] 所有课程已完成
```

异常情况：
```
[ZJOOC] 播放被拦截，1s 后重试
[ZJOOC] 进度卡在 05:21，尝试恢复
[ZJOOC] 轻量恢复无效，执行完整设置
```

## 兼容性

- ✅ Chrome + Tampermonkey
- ✅ Edge + Tampermonkey
- ✅ Firefox + Greasemonkey（未完整测试）
- ⚠️ 依赖 Vue 2 + ElementUI 渲染的浙学网页面结构

## 常见问题

**Q: 脚本不运行，控制台无任何 `[ZJOOC]` 日志**
A: 检查 URL 是否被 `@match` 规则匹配（必须是 `/ucenter/student/course/study/*/plan/detail/*`），检查 Tampermonkey 是否已启用

**Q: 视频无法自动播放**
A: 浏览器可能拦截了脚本的自动播放请求。脚本会静音后再尝试播放，并自动重试。如果多次失败，检查浏览器 Audio 自动播放策略

**Q: 倍速切换后无效**
A: 脚本通过 `video.playbackRate` 直接设置速率，部分视频播放器会周期性回写覆盖。脚本也尝试通过点击播放器 UI 的倍速按钮 + 面板选项双重设置

**Q: 跳转后卡顿很久才播放**
A: 导航后的 NAVIGATING 状态等待视频加载完成，最慢 3 秒。如果超过 10 秒仍未播放，检查浏览器控制台是否有其他错误

**Q: 面板按钮没响应**
A: 检查控制台是否有 `[ZJOOC]` 错误日志，刷新页面重试
