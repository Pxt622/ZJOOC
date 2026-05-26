// ==UserScript==
// @name         ZJOOC 智能刷课助手
// @namespace    zjooc-auto-v2
// @version      2.0.0
// @description  在浙学(zjooc.cn)自动刷课：视频倍速/静音/后台播放/自动跳转/图文跳过/可折叠配置面板
// @author       OpenCode
// @match        *://www.zjooc.cn/ucenter/student/course/study/*/plan/detail/*
// @grant        none
// @supportURL   https://github.com
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // 注入锁：防止脚本被重复注入
    if (window.__zjoocLoaded) {
        console.log('[ZJOOC] 脚本已加载，跳过重复注入');
        return;
    }
    window.__zjoocLoaded = true;

    // ============================================================
    // 模块 1: CONFIG — 可配置参数
    // ============================================================

    const CONFIG = {
        speedIndex: 3,         // 倍速索引：0=16x, 1=8x, 2=4x, 3=2x, 4=1.5x, 5=1.25x, 6=1x, 7=0.5x
        mute: true,            // 自动静音
        autoNext: true,        // 自动跳转下一章节
        docWaitTime: 10,       // 图文章节等待时间（秒）
        checkInterval: 3000,   // 主循环间隔（毫秒）
        startDelay: 5000,      // 页面加载后首次启动延迟（毫秒）
        maxRetry: 5,           // 视频未就绪最大重试次数
        retryInterval: 2000,   // 重试间隔（毫秒）
        antiFreezeInterval: 30000,  // 模拟用户活动间隔（毫秒）
        navDelay: 3000,        // 章节跳转后等待 DOM 更新（毫秒）
        maxConsecutiveSkip: 3, // 连续跳过已完成内容上限（达到后判定全部完成）
        maxSpeed: 4,           // 安全倍速上限
    };

    // speedIndex → video.playbackRate 映射
    const SPEED_MAP = ['16', '8', '4', '2', '1.5', '1.25', '1', '0.5'];
    // UI 下拉框的显示标签
    const SPEED_LABELS = ['16x', '8x', '4x', '2x', '1.5x', '1.25x', '1x', '0.5x'];

    // ============================================================
    // 模块 2: LOGGER — 统一日志
    // ============================================================

    function log(msg) {
        console.log('[ZJOOC]', msg);
    }
    function warn(msg) {
        console.warn('[ZJOOC]', msg);
    }

    // ============================================================
    // 模块 3: ANTI_DETECT — 防检测
    // ============================================================

    function initAntiDetect() {
        try {
            Object.defineProperty(document, 'hidden', {
                configurable: true,
                get: function () { return false; }
            });
            Object.defineProperty(document, 'visibilityState', {
                configurable: true,
                get: function () { return 'visible'; }
            });
        } catch (e) {
            warn('防检测设置失败: ' + e.message);
        }

        setInterval(function () {
            try {
                var evt = new MouseEvent('mousemove', { bubbles: true });
                document.body.dispatchEvent(evt);
                document.documentElement.dispatchEvent(evt);
            } catch (e) { /* 静默忽略 */ }
        }, CONFIG.antiFreezeInterval);

        log('防检测模块已启动');
    }

    // ============================================================
    // 模块 4: SELECTORS — DOM 查找（querySelector 优先 + 索引 fallback）
    // ============================================================

    function getVideo() {
        return document.querySelector('video');
    }

    function getSpeedContainer(video) {
        if (!video || !video.parentNode) return null;
        var controls = video.parentNode.childNodes[2];
        if (!controls || !controls.children) return null;
        var btn = controls.children[13];
        if (btn) return btn;
        btn = controls.querySelector('[class*="playbackrate"]');
        return btn;
    }

    function getMuteButton(video) {
        var parent = video && video.parentNode && video.parentNode.childNodes
            ? video.parentNode.childNodes[2] : null;
        if (!parent) return null;
        var byClass = parent.querySelector('[class*="mute"]');
        if (byClass) return byClass;
        return parent.children[18] || null;
    }

    function getPlayLayer(video) {
        if (!video || !video.parentNode) return null;
        var center = video.parentNode.childNodes[10];
        if (center) return center;
        return document.querySelector('[class*="pausecenter"]');
    }

    function getProgressElement(video) {
        var parent = video && video.parentNode && video.parentNode.childNodes
            ? video.parentNode.childNodes[2] : null;
        if (!parent) return null;
        var timeRegex = /\d{1,2}:\d{2}\s*\/\s*\d{1,2}:\d{2}/;
        for (var i = 0; i < parent.children.length; i++) {
            var c = parent.children[i];
            if (c.textContent && timeRegex.test(c.textContent.trim())) return c;
        }
        for (var j = 0; j < parent.children.length; j++) {
            var d = parent.children[j];
            if (d.textContent && d.textContent.indexOf('/') !== -1) return d;
        }
        return parent.children[7] || null;
    }

    function getActiveChapter() {
        return document.querySelector('.base-asider .el-menu-item.is-active');
    }

    function getActiveSubmenu() {
        return document.querySelector('.base-asider .el-submenu.is-active');
    }

    function normalize(str) {
        if (!str) return '';
        return str.replace(/\s+/g, ' ').trim();
    }

    function getBreadcrumbChapterName() {
        var li = document.querySelectorAll('.plan-detail > .el-header > ul > li');
        if (li[0]) return normalize(li[0].textContent);
        var bc = document.querySelector('.el-breadcrumb__item');
        if (bc) return normalize(bc.textContent);
        return null;
    }

    function getSubmenuTitle(submenu) {
        var eno = submenu.querySelector('.of_eno');
        if (eno) return normalize(eno.textContent);
        var title = submenu.querySelector('.el-submenu__title');
        if (title) return normalize(title.textContent);
        return null;
    }

    // ============================================================
    // 模块 5: VIDEO — 视频操控
    // ============================================================

    var stuckTimeoutId = null;
    var verifyTimeoutId = null;

    function clearTimeouts() {
        if (stuckTimeoutId) {
            clearTimeout(stuckTimeoutId);
            stuckTimeoutId = null;
        }
        if (verifyTimeoutId) {
            clearTimeout(verifyTimeoutId);
            verifyTimeoutId = null;
        }
    }

    function safePlay(vid) {
        if (!vid) return;
        try {
            document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        } catch (e) { /* ignore */ }
        var p = vid.play();
        if (p) {
            p.catch(function () {
                log('播放被拦截，1s 后重试');
                setTimeout(function () {
                    var v = getVideo();
                    if (v) v.play().catch(function () {});
                }, 1000);
            });
        }
    }

    function setupVideo() {
        var vid = getVideo();
        if (!vid) return false;

        var speedBtn = getSpeedContainer(vid);
        if (speedBtn) speedBtn.click();

        vid = getVideo();
        if (!vid) return false;

        var rate = Math.min(parseFloat(SPEED_MAP[CONFIG.speedIndex]), CONFIG.maxSpeed);
        if (rate > 0) vid.playbackRate = rate;

        var targetIndex = CONFIG.speedIndex;
        setTimeout(function () {
            var panel = document.querySelector('[class*="playbackratep"]');
            if (panel && panel.children[targetIndex]) {
                panel.children[targetIndex].click();
            }
        }, 350);

        if (CONFIG.mute) {
            var muteBtn = getMuteButton(vid);
            if (muteBtn) muteBtn.click();
            vid = getVideo();
            if (vid) vid.muted = true;
        }

        safePlay(vid);

        verifyTimeoutId = setTimeout(function () {
            verifyTimeoutId = null;
            verifyPlaying();
        }, 500);

        return true;
    }

    function verifyPlaying() {
        var vid = getVideo();
        if (!vid) return;
        if (vid.paused || vid.currentTime === 0) {
            log('视频未成功开始播放，再次尝试');
            var playLayer = getPlayLayer(vid);
            if (playLayer) playLayer.click();
            vid.play().catch(function () {});
        }
    }

    function resumeVideo() {
        var vid = getVideo();
        if (vid && vid.paused) {
            var playLayer = getPlayLayer(vid);
            if (playLayer) playLayer.click();
            vid.play().catch(function () {});
        }
    }

    function reapplySettings() {
        var vid = getVideo();
        if (!vid) return;
        var rate = Math.min(parseFloat(SPEED_MAP[CONFIG.speedIndex]), CONFIG.maxSpeed);
        if (rate > 0) vid.playbackRate = rate;
        vid.muted = CONFIG.mute;
        updateStatusText('播放中 ' + SPEED_LABELS[CONFIG.speedIndex]);
    }

    function ensurePlaying() {
        var vid = getVideo();
        if (!vid) return 'no_video';
        if (vid.ended) return 'ended';
        if (vid.paused) {
            vid.play().catch(function () {});
        }
        return 'playing';
    }

    function parseProgress() {
        var vid = getVideo();
        if (!vid) return null;
        var el = getProgressElement(vid);
        if (!el) return null;
        var text = el.textContent.trim();
        var parts = text.split('/');
        if (parts.length !== 2) return null;
        var current = parts[0].trim();
        var total = parts[1].trim();
        return {
            current: current,
            total: total,
            isEnd: current === total && current !== '00:00'
        };
    }

    function isCompleted() {
        // 策略 1：tab 上的 complete 图标
        var icon = document.querySelector('.el-tabs__nav .is-active i.complete');
        if (icon && icon.classList.contains('complete')) return true;

        // 策略 2：sidebar 激活项有完成标记
        var activeItem = getActiveChapter();
        if (activeItem) {
            if (activeItem.querySelector('.el-icon-check, [class*="complete"]')) return true;
        }

        // 策略 3：进度已 100%（非零时长）
        var prog = parseProgress();
        if (prog && prog.isEnd) return true;

        return false;
    }

    // ============================================================
    // 模块 6: DOCUMENT — 图文章节处理
    // ============================================================

    var docStartTime = null;

    function handleDocument() {
        if (docStartTime === null) {
            docStartTime = Date.now();
            log('检测到图文章节，等待 ' + CONFIG.docWaitTime + ' 秒后跳转');
            // 点击"完成学习"按钮（仅一次）
            var btn = document.querySelector('.el-main .el-button');
            if (btn) {
                btn.click();
            }
            return 'waiting';
        }
        if (Date.now() - docStartTime >= CONFIG.docWaitTime * 1000) {
            return 'done';
        }
        return 'waiting';
    }

    // ============================================================
    // 模块 7: NAVIGATION — 章节导航
    // ============================================================

    function syncSidebar() {
        var chapterName = getBreadcrumbChapterName();
        if (!chapterName) return false;

        var submenus = document.querySelectorAll('.base-asider .el-submenu');
        for (var i = 0; i < submenus.length; i++) {
            var sm = submenus[i];
            var title = getSubmenuTitle(sm);
            if (title !== chapterName) continue;

            if (!sm.classList.contains('is-opened')) {
                var titleEl = sm.querySelector('.el-submenu__title');
                if (titleEl) titleEl.click();
            }
            return true;
        }
        return false;
    }

    function getNextElementSibling(el) {
        if (!el) return null;
        var next = el.nextSibling;
        while (next && next.nodeType !== 1) next = next.nextSibling;
        return next;
    }

    function nextChapter() {
        // 第 1 层：同节内跳标签页（排除前 2 个非视频标签）
        var allTabs = document.querySelectorAll('.el-tabs__nav > .el-tabs__item[role="tab"]');
        var videoTabs = [];
        for (var a = 0; a < allTabs.length; a++) {
            if (a >= 2) videoTabs.push(allTabs[a]);
        }
        var activeTab = null;
        for (var b = 0; b < videoTabs.length; b++) {
            if (videoTabs[b].getAttribute('aria-selected') === 'true') {
                activeTab = videoTabs[b];
                break;
            }
        }
        if (activeTab && videoTabs.length > 1) {
            var idx = videoTabs.indexOf(activeTab);
            if (idx < videoTabs.length - 1) {
                videoTabs[idx + 1].click();
                log('跳转 - 同节下一标签');
                return true;
            }
        }

        // 第 2 层：同章内跳下一节
        var activeSubmenu = getActiveSubmenu();
        if (activeSubmenu) {
            var activeItem = activeSubmenu.querySelector('.el-menu-item.is-active');
            var nextItem = getNextElementSibling(activeItem);
            if (nextItem) {
                nextItem.click();
                log('跳转 - 同章下一节');
                return true;
            }
        }

        // 第 3 层：跳下一章第一节
        if (activeSubmenu) {
            var nextSubmenu = getNextElementSibling(activeSubmenu);
            if (nextSubmenu) {
                var firstItem = nextSubmenu.querySelector('.el-menu-item');
                if (firstItem) {
                    firstItem.click();
                    log('跳转 - 下一章第一节');
                    return true;
                }
            }
        }

        // 第 4 层：全部完成
        log('所有课程已完成');
        return false;
    }

    // ============================================================
    // 模块 8: UI_PANEL — 右下角自包含浮动配置面板
    // ============================================================

    function buildPanel() {
        // 最外层容器 — 固定右下角，独立于页面 DOM 结构
        var wrapper = document.createElement('div');
        wrapper.id = 'zjooc-panel-wrapper';
        wrapper.style.cssText =
            'position:fixed !important;bottom:20px !important;right:20px !important;' +
            'z-index:99999 !important;font-family:"Microsoft YaHei","PingFang SC",sans-serif !important;';

        // 折叠按钮 — 蓝底白字，始终可见
        var toggle = document.createElement('div');
        toggle.style.cssText =
            'background:#409eff !important;color:#fff !important;padding:6px 14px !important;' +
            'border-radius:6px !important;cursor:pointer !important;font-size:13px !important;' +
            'font-weight:bold !important;text-align:center !important;' +
            'user-select:none !important;box-shadow:0 2px 8px rgba(64,158,255,0.4) !important;';
        toggle.textContent = '[ZJOOC] \u2699';

        // 展开面板 — 向上弹出
        var detail = document.createElement('div');
        detail.style.cssText =
            'display:none;position:absolute !important;bottom:100% !important;right:0 !important;' +
            'margin-bottom:8px !important;background:#fff !important;border:1px solid #e4e7ed !important;' +
            'border-radius:8px !important;padding:14px !important;min-width:220px !important;' +
            'box-shadow:0 4px 16px rgba(0,0,0,0.12) !important;' +
            'font-size:13px !important;line-height:30px !important;color:#303133 !important;';

        // ---- 倍速下拉框 ----
        var speedDiv = document.createElement('div');
        speedDiv.style.cssText = 'overflow:hidden !important;';
        var speedLabel = document.createElement('span');
        speedLabel.textContent = '倍速:';
        var speedSelect = document.createElement('select');
        speedSelect.style.cssText =
            'float:right !important;padding:2px 6px !important;border:1px solid #dcdfe6 !important;' +
            'border-radius:4px !important;font-size:12px !important;';
        for (var s = 0; s < SPEED_LABELS.length; s++) {
            var opt = document.createElement('option');
            opt.value = s;
            opt.textContent = SPEED_LABELS[s];
            if (s === CONFIG.speedIndex) opt.selected = true;
            speedSelect.appendChild(opt);
        }
        speedSelect.onchange = function (e) {
            CONFIG.speedIndex = parseInt(e.target.value, 10);
            reapplySettings();
        };
        speedDiv.appendChild(speedLabel);
        speedDiv.appendChild(speedSelect);

        // ---- 静音开关 ----
        var muteDiv = document.createElement('div');
        muteDiv.style.cssText = 'overflow:hidden !important;';
        var muteLabel = document.createElement('span');
        muteLabel.textContent = '静音:';
        var muteCheckbox = document.createElement('input');
        muteCheckbox.type = 'checkbox';
        muteCheckbox.checked = CONFIG.mute;
        muteCheckbox.style.cssText = 'float:right !important;margin-top:8px !important;';
        muteCheckbox.onchange = function (e) {
            CONFIG.mute = e.target.checked;
            reapplySettings();
        };
        muteDiv.appendChild(muteLabel);
        muteDiv.appendChild(muteCheckbox);

        // ---- 自动跳转开关 ----
        var autoDiv = document.createElement('div');
        autoDiv.style.cssText = 'overflow:hidden !important;';
        var autoLabel = document.createElement('span');
        autoLabel.textContent = '自动跳转:';
        var autoCheckbox = document.createElement('input');
        autoCheckbox.type = 'checkbox';
        autoCheckbox.checked = CONFIG.autoNext;
        autoCheckbox.style.cssText = 'float:right !important;margin-top:8px !important;';
        autoCheckbox.onchange = function (e) { CONFIG.autoNext = e.target.checked; };
        autoDiv.appendChild(autoLabel);
        autoDiv.appendChild(autoCheckbox);

        // ---- 图文等待时间 ----
        var waitDiv = document.createElement('div');
        waitDiv.style.cssText = 'overflow:hidden !important;';
        var waitLabel = document.createElement('span');
        waitLabel.textContent = '图文等待(秒):';
        var waitInput = document.createElement('input');
        waitInput.type = 'number';
        waitInput.min = '1';
        waitInput.value = CONFIG.docWaitTime;
        waitInput.style.cssText =
            'float:right !important;width:54px !important;padding:2px 6px !important;' +
            'border:1px solid #dcdfe6 !important;border-radius:4px !important;font-size:12px !important;';
        waitInput.onchange = function (e) {
            CONFIG.docWaitTime = Math.max(1, parseInt(e.target.value, 10) || 10);
        };
        waitDiv.appendChild(waitLabel);
        waitDiv.appendChild(waitInput);

        // ---- 分隔线 ----
        var divider = document.createElement('div');
        divider.style.cssText = 'border-top:1px solid #ebeef5 !important;margin:10px 0 !important;clear:both !important;';

        // ---- 状态显示 ----
        var statusDiv = document.createElement('div');
        statusDiv.style.cssText = 'color:#909399 !important;font-size:12px !important;text-align:center !important;clear:both !important;';
        statusDivRef = statusDiv;

        // ---- 控制按钮 ----
        var btnDiv = document.createElement('div');
        btnDiv.style.cssText = 'text-align:center !important;margin-top:8px !important;clear:both !important;';

        var startBtn = document.createElement('button');
        startBtn.textContent = '开始';
        startBtn.style.cssText =
            'margin:0 4px !important;padding:4px 14px !important;border:none !important;border-radius:4px !important;' +
            'background:#409eff !important;color:#fff !important;font-size:12px !important;cursor:pointer !important;';
        startBtn.onclick = function () {
            STATE.isRunning = true;
            docStartTime = null;
            updateStatusText('运行中');
        };

        var stopBtn = document.createElement('button');
        stopBtn.textContent = '暂停';
        stopBtn.style.cssText =
            'margin:0 4px !important;padding:4px 14px !important;border:none !important;border-radius:4px !important;' +
            'background:#f0f0f0 !important;color:#606266 !important;font-size:12px !important;cursor:pointer !important;';
        stopBtn.onclick = function () {
            STATE.isRunning = false;
            updateStatusText('已暂停');
        };

        btnDiv.appendChild(startBtn);
        btnDiv.appendChild(stopBtn);

        // ---- 组装面板 ----
        detail.appendChild(speedDiv);
        detail.appendChild(muteDiv);
        detail.appendChild(autoDiv);
        detail.appendChild(waitDiv);
        detail.appendChild(divider);
        detail.appendChild(btnDiv);
        detail.appendChild(statusDiv);

        // ---- 展开/折叠交互 ----
        toggle.onclick = function () {
            if (detail.style.display === 'none' || detail.style.display === '') {
                detail.style.display = 'block';
            } else {
                detail.style.display = 'none';
            }
        };

        wrapper.appendChild(toggle);
        wrapper.appendChild(detail);
        document.body.appendChild(wrapper);

        log('配置面板已就绪');
    }

    // 状态栏 DOM 引用（由 buildPanel 设置，updateStatusText 使用）
    var statusDivRef = null;

    function updateStatusText(text) {
        if (statusDivRef) {
            statusDivRef.textContent = '状态: ' + text;
        }
    }

    // ============================================================
    // 模块 9: STATE + MAIN — 主循环状态机
    // ============================================================

    var STATE = {
        phase: 'IDLE',             // IDLE | VIDEO_PLAYING | DOCUMENT | NEXT | NAVIGATING | COMPLETED
        retryCount: 0,
        lastProgress: '00:00',
        isRunning: true,
        navStartTime: 0,
        navChapterName: null,
        consecutiveSkip: 0
    };

    function main() {
        if (!STATE.isRunning) return;

        try {
            switch (STATE.phase) {
                case 'IDLE': {
                    // 页面就绪检测
                    var sidebarReady = !!document.querySelector('.el-menu-item');
                    if (!sidebarReady) {
                        log('页面尚未就绪，等待中...');
                        return;
                    }

                    if (isCompleted() && CONFIG.autoNext) {
                        if (++STATE.consecutiveSkip >= CONFIG.maxConsecutiveSkip) {
                            log('连续 ' + CONFIG.maxConsecutiveSkip + ' 次跳过已完成，全部结束');
                            STATE.phase = 'COMPLETED';
                            updateStatusText('全部完成');
                            break;
                        }
                        log('跳过已完成内容');
                        STATE.phase = 'NEXT';
                        break;
                    }
                    // 当前内容未完成 → 重置跳过计数
                    STATE.consecutiveSkip = 0;

                    var vid = getVideo();
                    if (vid) {
                        if (setupVideo()) {
                            STATE.phase = 'VIDEO_PLAYING';
                            STATE.retryCount = 0;
                            STATE.lastProgress = '00:00';
                            updateStatusText('播放中 ' + SPEED_LABELS[CONFIG.speedIndex]);
                        } else if (++STATE.retryCount > CONFIG.maxRetry) {
                            log('视频设置重试 ' + CONFIG.maxRetry + ' 次失败，跳过本章');
                            STATE.phase = 'NEXT';
                        }
                    } else {
                        var hasPlayer = document.querySelector('[class*="controlbar"]') || document.querySelector('[class*="pausecenter"]');
                        if (hasPlayer) {
                            STATE.phase = 'IDLE';
                        } else {
                            STATE.phase = 'DOCUMENT';
                            docStartTime = null;
                        }
                    }
                    break;
                }

                case 'VIDEO_PLAYING': {
                    var status = ensurePlaying();
                    if (status === 'ended') {
                        clearTimeouts();
                        STATE.phase = 'NEXT';
                        break;
                    }
                    if (status === 'no_video') {
                        clearTimeouts();
                        STATE.phase = 'IDLE';
                        break;
                    }

                    var prog = parseProgress();
                    if (prog && prog.isEnd) {
                        clearTimeouts();
                        STATE.phase = 'NEXT';
                        break;
                    }

                    // 防卡住：进度不变时尝试恢复
                    if (prog && prog.current !== '00:00'
                        && prog.current === STATE.lastProgress
                        && prog.current !== prog.total) {
                        log('进度卡在 ' + prog.current + '，尝试恢复');
                        resumeVideo();
                        stuckTimeoutId = setTimeout(function () {
                            stuckTimeoutId = null;
                            var p2 = parseProgress();
                            if (p2 && p2.current === prog.current) {
                                log('轻量恢复无效，执行完整设置');
                                setupVideo();
                            }
                        }, 1000);
                    }

                    STATE.lastProgress = prog ? prog.current : '00:00';
                    break;
                }

                case 'DOCUMENT': {
                    // 如果视频重新出现，回到 IDLE
                    if (getVideo()) {
                        docStartTime = null;
                        STATE.phase = 'IDLE';
                        break;
                    }
                    if (handleDocument() === 'done') {
                        STATE.phase = 'NEXT';
                    }
                    break;
                }

                case 'NEXT': {
                    if (!CONFIG.autoNext) {
                        STATE.phase = 'IDLE';
                        updateStatusText('等待手动跳转');
                        break;
                    }
                    if (!nextChapter()) {
                        STATE.phase = 'COMPLETED';
                        updateStatusText('全部完成');
                        clearTimeouts();
                        break;
                    }
                    STATE.phase = 'NAVIGATING';
                    STATE.navStartTime = Date.now();
                    var ch = getActiveChapter();
                    STATE.navChapterName = ch ? ch.textContent.trim() : null;
                    docStartTime = null;
                    clearTimeouts();
                    updateStatusText('跳转中...');
                    break;
                }

                case 'NAVIGATING': {
                    var elapsed = Date.now() - STATE.navStartTime;
                    var vid = getVideo();
                    if (vid || elapsed >= CONFIG.navDelay) {
                        STATE.phase = 'IDLE';
                        STATE.navChapterName = null;
                        syncSidebar();
                    }
                    break;
                }

                case 'COMPLETED': {
                    // 终端状态，停止一切活动
                    break;
                }
            }
        } catch (e) {
            warn('主循环异常: ' + e.message);
            clearTimeouts();
            STATE.phase = 'IDLE';
        }
    }

    // ============================================================
    // 启动入口
    // ============================================================

    function bootstrap() {
        initAntiDetect();
        syncSidebar();
        buildPanel();
        setInterval(main, CONFIG.checkInterval);
        updateStatusText('等待启动...');
        log('ZJOOC 智能刷课助手 v2.0 已启动');
        log('匹配页面: ' + window.location.href);
    }

    setTimeout(bootstrap, CONFIG.startDelay);

})();
