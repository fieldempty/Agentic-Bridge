// ==UserScript==
// @name         DeepSeek Agentic Bridge — Auto Mode
// @namespace    http://tampermonkey.net/
// @version      2.8
// @description  Auto-detect shebang scripts in DeepSeek, execute in UCRT64, return results
// @author       You
// @match        https://chat.deepseek.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const WS_URL = 'ws://localhost:8765';
    const REPORT_URL = 'ws://localhost:8765/report';
    let ws = null;
    let reportWs = null;
    let reconnectTimer = null;
    let processedScripts = new Set();
    let isAutoExec = false;
    let isAutoSend = false;
    let lastResult = null;
    let currentTab = 'log';
    let agenticLoopActive = false;
    let agenticLoopPrompt = 'Please analyze the results and continue with the next step.';
    let sendRetryCount = 0;
    let maxSendRetries = 5;

    let streamCheckInterval = null;
    let watchedMessages = new Map();
    let processingQueue = new Set();
    let isDeepSeekStreaming = false;

    // ── WebSocket ──────────────────────────────────────────────
    function connectWS() {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        try { ws = new WebSocket(WS_URL); }
        catch (e) { logPanel('WS create failed: ' + e.message, 'error'); scheduleReconnect(); return; }
        ws.onopen = function() { updatePanelStatus('connected'); logPanel('Bridge connected', 'success'); connectReportWS(); };
        ws.onmessage = function(event) {
            try {
                var msg = JSON.parse(event.data);
                if (msg.type === 'stream') appendOutput(msg.data);
                else if (msg.type === 'done') finalizeOutput(msg.code);
                else if (msg.type === 'error') { appendOutput('\n[ERROR] ' + msg.data + '\n'); finalizeOutput(1); }
            } catch (e) { logPanel('Bad message: ' + event.data, 'error'); }
        };
        ws.onclose = function() { updatePanelStatus('disconnected'); logPanel('Disconnected', 'warning'); ws = null; scheduleReconnect(); };
        ws.onerror = function() { updatePanelStatus('error'); ws = null; };
    }

    function connectReportWS() {
        if (reportWs && reportWs.readyState === WebSocket.OPEN) return;
        try {
            reportWs = new WebSocket(REPORT_URL);
            reportWs.onmessage = function(event) {
                try { var msg = JSON.parse(event.data); if (msg.type === 'report' || msg.type === 'report_update') updateNotepad(msg.content); } catch (e) {}
            };
            reportWs.onclose = function() { reportWs = null; };
            reportWs.onerror = function() { reportWs = null; };
        } catch (e) {}
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(function() { reconnectTimer = null; connectWS(); }, 3000);
    }

    function sendRaw(data) {
        if (!ws || ws.readyState !== WebSocket.OPEN) { logPanel('Not connected', 'error'); return false; }
        try { ws.send(JSON.stringify(data)); return true; }
        catch (e) { logPanel('Failed to send: ' + e.message, 'error'); return false; }
    }

    // ── Script Execution State ─────────────────────────────────
    var currentOutput = '';
    var currentScript = null;

    function executeScript(scriptContent, scriptId) {
        var loginCheckbox = document.getElementById('agentic-login-shell');
        var useLoginShell = loginCheckbox ? loginCheckbox.checked : false;
        if (!sendRaw({ id: scriptId, command: scriptContent, login_shell: useLoginShell })) return false;
        currentOutput = '';
        currentScript = { id: scriptId, content: scriptContent };
        updateModeStatus('executing', 'EXECUTING...');
        logPanel('Executing script ' + scriptId.slice(-6) + '...', 'cmd');
        return true;
    }

    function appendOutput(chunk) {
        currentOutput += chunk;
        var preview = document.getElementById('agentic-live-output');
        if (preview) {
            var display = currentOutput.length > 2000 ? '...' + currentOutput.slice(-2000) : currentOutput;
            preview.textContent = display;
        }
    }

    function finalizeOutput(exitCode) {
        var script = currentScript;
        currentScript = null;
        if (!script) return;
        var status = exitCode === 0 ? 'OK' : 'WARN';
        logPanel(status + ' Script done (exit ' + exitCode + ')', exitCode === 0 ? 'success' : 'warning');
        lastResult = { output: currentOutput, exitCode: exitCode, scriptId: script.id };
        updateResultsTab(currentOutput, exitCode);
        sendRetryCount = 0;

        if (isAutoSend && agenticLoopActive) {
            updateModeStatus('sending', 'SENDING...');
            attemptSendWithRetry(currentOutput, exitCode, script.id, true);
        } else if (isAutoSend) {
            updateModeStatus('sending', 'SENDING...');
            attemptSendWithRetry(currentOutput, exitCode, script.id, false);
        } else {
            updateModeStatus('', 'READY');
            flashSendButton();
        }
    }

    function attemptSendWithRetry(output, exitCode, scriptId, isAgentic) {
        var success = sendResultToDeepSeek(output, exitCode, scriptId);
        if (success) {
            sendRetryCount = 0;
            if (isAgentic) {
                updateModeStatus('waiting', 'WAITING FOR AI...');
                watchForAIResponse();
            } else {
                updateModeStatus('', 'READY');
            }
        } else if (sendRetryCount < maxSendRetries) {
            sendRetryCount++;
            logPanel('Send failed, retry ' + sendRetryCount + '/' + maxSendRetries + '...', 'warning');
            updateModeStatus('waiting', 'RETRY ' + sendRetryCount + '...');
            setTimeout(function() { attemptSendWithRetry(output, exitCode, scriptId, isAgentic); }, 2000);
        } else {
            logPanel('Send failed after ' + maxSendRetries + ' retries', 'error');
            updateModeStatus('error', 'SEND FAILED');
            flashSendButton();
        }
    }

    function flashSendButton() {
        var btn = document.getElementById('agentic-send-ds');
        if (btn) { btn.style.animation = 'none'; btn.offsetHeight; btn.style.animation = 'pulse 1s ease 3'; }
    }

    // ── DeepSeek UI Detection ──────────────────────────────────
    function findDeepSeekTextarea() {
        var textareas = document.querySelectorAll('textarea');
        for (var i = 0; i < textareas.length; i++) { if (isVisible(textareas[i])) return textareas[i]; }
        return null;
    }

    function findDeepSeekSendButton() {
        var buttons = document.querySelectorAll('div[role="button"]');
        for (var i = 0; i < buttons.length; i++) {
            var btn = buttons[i];
            if (btn.querySelector('svg') && isVisible(btn)) {
                var rect = btn.getBoundingClientRect();
                if (rect.bottom > window.innerHeight - 150 && rect.right > window.innerWidth - 100) return btn;
            }
        }
        return null;
    }

    function isVisible(el) {
        if (!el) return false;
        var style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' &&
               el.offsetParent !== null && el.getBoundingClientRect().width > 0;
    }

    // ── Streaming Detection ────────────────────────────────────
    function detectStreamingState() {
        var streamingSelectors = ['.ds-streaming', '[data-streaming="true"]', '.streaming', '.typing-indicator', '.cursor-blink', '.animate-pulse'];
        for (var i = 0; i < streamingSelectors.length; i++) {
            try { if (document.querySelector(streamingSelectors[i])) return true; } catch (e) {}
        }
        var stopButtons = document.querySelectorAll('button[aria-label*="Stop"], button[title*="Stop"], .stop-generating');
        for (var j = 0; j < stopButtons.length; j++) { if (isVisible(stopButtons[j])) return true; }
        return false;
    }

    setInterval(function() {
        var wasStreaming = isDeepSeekStreaming;
        isDeepSeekStreaming = detectStreamingState();
        if (wasStreaming && !isDeepSeekStreaming) logPanel('AI finished streaming', 'info');
    }, 2000);

    // ── Inject Result into DeepSeek ────────────────────────────
    function sendResultToDeepSeek(output, exitCode, scriptId) {
        if (isDeepSeekStreaming) { logPanel('Cannot send - AI streaming', 'warning'); return false; }
        var textarea = findDeepSeekTextarea();
        if (!textarea) { logPanel('No textarea found', 'error'); updateModeStatus('error', 'NO TEXTAREA'); return false; }
        var truncated = output.length > 8000 ? output.slice(0, 8000) + '\n\n[... truncated ...]' : output;
        var resultText = 'Script execution result (exit ' + exitCode + '):\n\n```\n' + truncated + '\n```\n\nPlease continue with the next step.';
        try {
            var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            setter.call(textarea, resultText);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
            logPanel('Result injected', 'info');
            var sent = submitDeepSeek();
            if (!sent) {
                setTimeout(function() { submitDeepSeek(); }, 500);
                setTimeout(function() { submitDeepSeek(); }, 1500);
            }
            return true;
        } catch (e) { logPanel('Error injecting: ' + e.message, 'error'); updateModeStatus('error', 'INJECT FAILED'); return false; }
    }

    function submitDeepSeek() {
        var btn = findDeepSeekSendButton();
        if (btn) {
            var isDisabled = btn.getAttribute('aria-disabled') === 'true' || btn.disabled || btn.classList.contains('ds-icon-button--disabled');
            if (!isDisabled) {
                btn.click();
                logPanel('Sent via button', 'success');
                updateModeStatus('', 'READY');
                return true;
            }
        }
        var textarea = findDeepSeekTextarea();
        if (textarea && textarea.value.trim().length > 0) {
            var enterEvent = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true });
            textarea.dispatchEvent(enterEvent);
            textarea.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
            setTimeout(function() {
                if (textarea.value === '') { logPanel('Message sent', 'success'); updateModeStatus('', 'READY'); }
                else logPanel('Message may not have sent', 'warning');
            }, 500);
            return true;
        }
        updateModeStatus('error', 'NO INPUT');
        return false;
    }

    // ── Agentic Loop ───────────────────────────────────────────
    function watchForAIResponse() {
        if (!agenticLoopActive) return;
        var checkCount = 0;
        var responseChecker = setInterval(function() {
            checkCount++;
            if (isDeepSeekStreaming) {
                logPanel('AI processing results...', 'info');
                updateModeStatus('waiting', 'AI THINKING...');
                var streamWatcher = setInterval(function() {
                    if (!isDeepSeekStreaming) {
                        clearInterval(streamWatcher);
                        logPanel('AI finished response', 'info');
                        setTimeout(function() { if (agenticLoopActive) promptAIToContinue(); }, 2000);
                    }
                }, 1000);
                clearInterval(responseChecker);
            } else if (checkCount >= 90) {
                clearInterval(responseChecker);
                logPanel('Timeout waiting for AI', 'warning');
                updateModeStatus('error', 'TIMEOUT');
                if (agenticLoopActive) promptAIToContinue();
            }
        }, 1000);
    }

    function promptAIToContinue() {
        if (!agenticLoopActive) return;
        var textarea = findDeepSeekTextarea();
        if (!textarea) { logPanel('No textarea for prompt', 'error'); return; }
        try {
            var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            setter.call(textarea, agenticLoopPrompt);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
            logPanel('Prompting AI...', 'info');
            updateModeStatus('sending', 'PROMPTING...');
            setTimeout(function() { submitDeepSeek(); updateModeStatus('executing', 'AGENTIC LOOP'); }, 400);
        } catch (e) { logPanel('Error prompting: ' + e.message, 'error'); }
    }

    // ── Markdown Parser ────────────────────────────────────────
    function parseMarkdown(md) {
        if (!md) return '<p><em>No content yet</em></p>';
        return md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/^### (.*$)/gim, '<h3>$1</h3>').replace(/^## (.*$)/gim, '<h2>$1</h2>').replace(/^# (.*$)/gim, '<h1>$1</h1>')
            .replace(/\*\*\*(.*?)\*\*\*/g, '<b><i>$1</i></b>').replace(/\*\*(.*?)\*\*/g, '<b>$1</b>').replace(/\*(.*?)\*/g, '<i>$1</i>')
            .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="agentic-md-code"><code>$2</code></pre>')
            .replace(/`([^`]+)`/g, '<code class="agentic-md-inline">$1</code>')
            .replace(/^---$/gim, '<hr>').replace(/\n/gim, '<br>');
    }

    function updateResultsTab(output, exitCode) {
        var rd = document.getElementById('agentic-results-content');
        if (!rd) return;
        var sc = exitCode === 0 ? '#4ade80' : '#f87171';
        rd.innerHTML = '<div style="color:' + sc + ';font-weight:bold;margin-bottom:6px;">Exit: ' + exitCode + '</div><pre style="background:#1e293b;padding:8px;border-radius:6px;border:1px solid #334155;max-height:300px;overflow-y:auto;margin:0;font:inherit;">' + escapeHtml(output) + '</pre>';
    }

    function updateNotepad(content) {
        var notepad = document.getElementById('agentic-notepad');
        if (notepad) notepad.innerHTML = parseMarkdown(content);
    }

    // ── Draggable Panel (both directions) ──────────────────────
    function makeDraggable(panel, handle) {
        var isDragging = false, startX = 0, startY = 0, startRight = 0, startBottom = 0;
        handle.style.cursor = 'grab';
        handle.addEventListener('mousedown', function(e) {
            if (e.target.closest('button')) return;
            isDragging = true;
            startX = e.clientX; startY = e.clientY;
            startRight = parseInt(panel.style.right) || 20;
            startBottom = parseInt(panel.style.bottom) || 20;
            handle.style.cursor = 'grabbing';
            e.preventDefault();
        });
        document.addEventListener('mousemove', function(e) {
            if (!isDragging) return;
            var dx = startX - e.clientX;
            var dy = startY - e.clientY;
            var newRight = startRight + dx;
            var newBottom = startBottom + dy;
            newRight = Math.max(0, Math.min(window.innerWidth - 200, newRight));
            newBottom = Math.max(0, Math.min(window.innerHeight - 40, newBottom));
            panel.style.right = newRight + 'px';
            panel.style.bottom = newBottom + 'px';
        });
        document.addEventListener('mouseup', function() { isDragging = false; handle.style.cursor = 'grab'; });
    }

    // ── GUI Panel ──────────────────────────────────────────────
    function createPanel() {
        if (document.getElementById('agentic-panel')) return;
        var panel = document.createElement('div');
        panel.id = 'agentic-panel';
        panel.style.bottom = '20px';
        panel.style.right = '20px';
        panel.innerHTML = '<div id="agentic-header"><span id="agentic-title">Agentic Bridge v2.8</span>' +
            '<div id="agentic-controls"><span id="agentic-status" title="Disconnected">RED</span>' +
            '<button id="agentic-minimize" title="Minimize">-</button></div></div>' +
            '<div id="agentic-body"><div id="agentic-toolbar">' +
            '<label title="Full agentic loop - AI auto-continues"><input type="checkbox" id="agentic-loop"><span>AGENT</span></label>' +
            '<label title="Auto-execute scripts"><input type="checkbox" id="agentic-auto-exec"><span>AUTO-EXEC</span></label>' +
            '<label title="Auto-send results"><input type="checkbox" id="agentic-auto-send"><span>AUTO-SEND</span></label>' +
            '<label title="Use bash -lc login shell"><input type="checkbox" id="agentic-login-shell"><span>LOGIN</span></label>' +
            '<span id="agentic-mode-status">READY</span>' +
            '<button id="agentic-scan" title="Scan for scripts">Scan</button>' +
            '<button id="agentic-send-ds" title="Send last result">Send</button>' +
            '<button id="agentic-clear">Clear</button></div>' +
            '<div id="agentic-tabs"><button class="agentic-tab active" data-tab="log">Log</button>' +
            '<button class="agentic-tab" data-tab="notepad">Notepad</button></div>' +
            '<button class="agentic-tab" data-tab="results">Results</button></div>' +
            '<div id="agentic-log" class="agentic-tab-content active"></div>' +
            '<div id="agentic-results" class="agentic-tab-content"><div id="agentic-results-content" style="font-family:monospace;font-size:11px;white-space:pre-wrap;color:#e2e8f0;padding:4px;"></div></div>' +
            '<div id="agentic-notepad" class="agentic-tab-content"></div>' +
            '<div id="agentic-live-output" title="Live output preview"></div>' +
            '<div id="agentic-input-row"><span id="agentic-prompt">$</span>' +
            '<input id="agentic-input" type="text" placeholder="Manual command..." autocomplete="off" spellcheck="false">' +
            '<button id="agentic-send" title="Send">Send</button></div></div>';

        var style = document.createElement('style');
        style.textContent = '@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(56,189,248,0.7)}50%{box-shadow:0 0 0 8px rgba(56,189,248,0)}}' +
            '#agentic-panel{position:fixed;bottom:20px;right:20px;width:540px;height:480px;background:#0f172a;border:1px solid #334155;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,0.6);font-family:monospace;font-size:12px;color:#e2e8f0;z-index:2147483647;display:flex;flex-direction:column;overflow:hidden}' +
            '#agentic-panel.minimized{width:220px;height:40px!important}#agentic-panel.minimized #agentic-body{display:none}' +
            '#agentic-header{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#1e293b;border-bottom:1px solid #334155;user-select:none;flex-shrink:0}' +
            '#agentic-title{font-weight:bold;color:#38bdf8;font-size:13px}#agentic-controls{display:flex;gap:6px;align-items:center}#agentic-status{font-size:10px}' +
            '#agentic-controls button{background:#334155;border:none;color:#94a3b8;width:20px;height:20px;border-radius:4px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center}' +
            '#agentic-controls button:hover{background:#475569;color:#fff}#agentic-body{display:flex;flex-direction:column;flex:1;min-height:0}' +
            '#agentic-toolbar{display:flex;justify-content:flex-start;align-items:center;padding:6px 10px;background:#1e293b;border-bottom:1px solid #334155;flex-shrink:0;gap:6px;flex-wrap:wrap}' +
            '#agentic-toolbar label{display:flex;align-items:center;gap:3px;cursor:pointer;font-size:10px;font-weight:bold;color:#94a3b8;user-select:none;white-space:nowrap}' +
            '#agentic-toolbar input[type="checkbox"]{accent-color:#10b981;width:13px;height:13px}' +
            '#agentic-scan{background:#0e7490;border:none;color:white;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:10px;font-weight:bold}' +
            '#agentic-scan:hover{background:#0891b2}' +
            '#agentic-send-ds{background:#4f46e5;border:none;color:white;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:11px;font-weight:bold;white-space:nowrap}' +
            '#agentic-send-ds:hover{background:#6366f1}#agentic-clear{background:#334155;border:none;color:#94a3b8;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:11px}' +
            '#agentic-clear:hover{background:#475569;color:#fff}#agentic-tabs{display:flex;background:#0f172a;border-bottom:1px solid #334155;flex-shrink:0}' +
            '.agentic-tab{flex:1;background:transparent;border:none;color:#64748b;padding:6px;cursor:pointer;font-size:11px;font-weight:bold;font-family:inherit;border-bottom:2px solid transparent}' +
            '.agentic-tab:hover{color:#94a3b8;background:#1e293b}.agentic-tab.active{color:#38bdf8;border-bottom-color:#38bdf8;background:#1e293b}' +
            '.agentic-tab-content{display:none;flex:1;overflow-y:auto;padding:8px;min-height:60px}.agentic-tab-content.active{display:block}' +
            '.agentic-line{margin:1px 0;padding:1px 4px;border-radius:3px;line-height:1.5;word-break:break-all;white-space:pre-wrap}' +
            '.agentic-line.info{color:#94a3b8}.agentic-line.success{color:#4ade80}.agentic-line.error{color:#f87171}.agentic-line.warning{color:#fbbf24}.agentic-line.cmd{color:#38bdf8;font-weight:bold}' +
            '.agentic-timestamp{color:#64748b;font-size:10px;margin-right:6px}' +
            '#agentic-live-output{max-height:100px;overflow-y:auto;padding:6px 10px;background:#020617;border-top:1px solid #1e293b;color:#a5b4fc;font-size:11px;white-space:pre-wrap;word-break:break-all;flex-shrink:0}' +
            '#agentic-input-row{display:flex;align-items:center;gap:6px;padding:8px 10px;border-top:1px solid #334155;background:#1e293b;flex-shrink:0}' +
            '#agentic-prompt{color:#4ade80;font-weight:bold;font-size:13px}' +
            '#agentic-input{flex:1;background:#0f172a;border:1px solid #334155;border-radius:6px;padding:5px 10px;color:#e2e8f0;font-family:inherit;font-size:12px;outline:none}' +
            '#agentic-input:focus{border-color:#38bdf8}#agentic-send{background:#059669;border:none;color:white;padding:5px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:bold}' +
            '#agentic-send:hover{background:#10b981}.agentic-exec-btn{background:#059669;color:white;border:none;padding:5px 14px;border-radius:6px;font-size:12px;font-weight:bold;cursor:pointer;margin:8px 0 4px 0;font-family:monospace;display:inline-flex;align-items:center;gap:6px}' +
            '.agentic-exec-btn:hover{background:#10b981}.agentic-exec-btn.sent{background:#4f46e5}.agentic-exec-btn.done{background:#475569;cursor:default}' +
            '#agentic-mode-status{font-size:10px;color:#64748b;margin-left:auto;padding:2px 8px;background:#1e293b;border-radius:4px}' +
            '#agentic-mode-status.executing{color:#fbbf24;animation:pulse 1.5s infinite}#agentic-mode-status.sending{color:#4f46e5;animation:pulse 1s infinite}' +
            '#agentic-mode-status.waiting{color:#f59e0b}#agentic-mode-status.error{color:#f87171}' +
            '.agentic-script-badge{display:inline-block;background:#1e293b;color:#38bdf8;padding:2px 8px;border-radius:4px;font-size:10px;margin-bottom:6px;border:1px solid #334155}';
        document.head.appendChild(style);
        document.body.appendChild(panel);
        makeDraggable(panel, document.getElementById('agentic-header'));

        // Event handlers
        document.getElementById('agentic-minimize').onclick = function(e) { e.stopPropagation(); panel.classList.toggle('minimized'); };
        document.getElementById('agentic-send').onclick = sendManual;
        document.getElementById('agentic-input').onkeydown = function(e) { if (e.key === 'Enter') sendManual(); };
        document.getElementById('agentic-clear').onclick = function() { document.getElementById('agentic-log').innerHTML = ''; };
        document.getElementById('agentic-auto-exec').onchange = function(e) { isAutoExec = e.target.checked; };
        document.getElementById('agentic-auto-send').onchange = function(e) { isAutoSend = e.target.checked; };

        // SCAN button - manually scan for scripts
        document.getElementById('agentic-scan').onclick = function() {
            logPanel('Manual scan triggered', 'info');
            scanAllMessages();
        };

        // AGENT checkbox
        document.getElementById('agentic-loop').onchange = function(e) {
            agenticLoopActive = e.target.checked;
            if (agenticLoopActive) {
                isAutoExec = true; isAutoSend = true;
                document.getElementById('agentic-auto-exec').checked = true;
                document.getElementById('agentic-auto-send').checked = true;
                logPanel('AGENT MODE ENABLED', 'success');
                updateModeStatus('executing', 'AGENT READY');
            } else {
                isAutoExec = false; isAutoSend = false;
                document.getElementById('agentic-auto-exec').checked = false;
                document.getElementById('agentic-auto-send').checked = false;
                logPanel('AGENT mode disabled', 'info');
                updateModeStatus('', 'READY');
            }
        };

        document.getElementById('agentic-login-shell').onchange = function(e) {
            logPanel(e.target.checked ? 'Login shell ON' : 'Login shell OFF', 'info');
        };
        document.getElementById('agentic-login-shell').checked = false;

        document.getElementById('agentic-send-ds').onclick = function() {
            if (!lastResult) { logPanel('No result to send', 'warning'); return; }
            sendRetryCount = 0;
            attemptSendWithRetry(lastResult.output, lastResult.exitCode, lastResult.scriptId, false);
        };

        var tabs = document.querySelectorAll('.agentic-tab');
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].onclick = function() {
                currentTab = this.dataset.tab;
                var allTabs = document.querySelectorAll('.agentic-tab');
                for (var j = 0; j < allTabs.length; j++) allTabs[j].classList.remove('active');
                var allContent = document.querySelectorAll('.agentic-tab-content');
                for (var k = 0; k < allContent.length; k++) allContent[k].classList.remove('active');
                this.classList.add('active');
                var contentEl = document.getElementById('agentic-' + this.dataset.tab);
                if (contentEl) contentEl.classList.add('active');
            };
        }
        logPanel('Bridge v2.8 loaded - Auto-scan every 10s', 'info');
        // Watch for AI finish indicators instead of polling
    }

    function logPanel(text, type) {
        var log = document.getElementById('agentic-log');
        if (!log) return;
        var line = document.createElement('div');
        line.className = 'agentic-line ' + (type || 'info');
        var time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        line.innerHTML = '<span class="agentic-timestamp">[' + time + ']</span>' + escapeHtml(text);
        log.appendChild(line);
        log.scrollTop = log.scrollHeight;
    }

    function updatePanelStatus(state) {
        var status = document.getElementById('agentic-status');
        if (!status) return;
        var icons = { connected: 'GREEN', disconnected: 'RED', error: 'ORANGE' };
        status.textContent = icons[state] || 'GRAY';
        status.title = state;
    }

    function updateModeStatus(state, text) {
        var status = document.getElementById('agentic-mode-status');
        if (!status) return;
        status.textContent = text || state.toUpperCase();
        status.className = state;
    }

    function sendManual() {
        var input = document.getElementById('agentic-input');
        var cmd = input.value.trim();
        if (!cmd) return;
        logPanel('$ ' + cmd, 'cmd');
        if (sendRaw({ id: 'manual-' + Date.now(), command: cmd, login_shell: document.getElementById('agentic-login-shell').checked })) input.value = '';
    }

    function escapeHtml(text) { var div = document.createElement('div'); div.textContent = text; return div.innerHTML; }

    // ── Script Detection (BASH ONLY) ───────────────────────────
    function extractScripts(element) {
        var scripts = [], seen = {};
        var codeBlocks = element.querySelectorAll('.md-code-block, pre code, pre');
        for (var i = 0; i < codeBlocks.length; i++) {
            var text = (codeBlocks[i].innerText || codeBlocks[i].textContent || '').trim();
            if (!text) continue;
            var firstLine = text.split('\n')[0].trim();
            var hasShebang = firstLine.indexOf('#!/') === 0;
            var isBashShebang = false;
            if (hasShebang) {
                var sl = firstLine.toLowerCase();
                isBashShebang = sl.indexOf('bash') !== -1 || sl.indexOf('sh') !== -1 || sl.indexOf('shell') !== -1 || sl.indexOf('zsh') !== -1;
            }
            var cls = (codeBlocks[i].className || '').toLowerCase();
            var langMatch = cls.match(/language-(\w+)/);
            var lang = langMatch ? langMatch[1] : '';
            if (isBashShebang || ['bash','sh','shell','zsh'].indexOf(lang) !== -1) {
                var hash = cyrb53(text);
                if (!seen[hash]) { seen[hash] = true; scripts.push({ type: 'bash', content: text, hash: hash }); }
            }
        }
        return scripts;
    }

    function cyrb53(str, seed) {
        seed = seed || 0;
        var h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
        for (var i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return 4294967296 * (2097151 & h2) + (h1 >>> 0);
    }

    // ── Streaming Detection ────────────────────────────────────
    function isStreaming(element) {
        var selectors = ['.ds-streaming', '[data-streaming="true"]', '.streaming', '.typing-indicator', '.cursor-blink', '.animate-pulse'];
        for (var i = 0; i < selectors.length; i++) { try { if (element.querySelector(selectors[i])) return true; } catch (e) {} }
        var codeBlocks = element.querySelectorAll('.md-code-block, pre code, pre');
        if (codeBlocks.length > 0) {
            var allText = element.innerText || element.textContent || '';
            if ((allText.match(/```/g) || []).length % 2 !== 0) return true;
        }
        return false;
    }

    function watchMessageForScripts(messageEl) {
        var mid = getMessageId(messageEl);
        if (messageEl.dataset.agenticProcessed === 'full' || watchedMessages.has(mid)) return;
        watchedMessages.set(mid, { element: messageEl, attempts: 0, maxAttempts: 30, lastContent: '' });
        if (!streamCheckInterval) streamCheckInterval = setInterval(checkWatchedMessages, 1000);
    }

    function getMessageId(el) {
        if (!el._agenticId) el._agenticId = 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
        return el._agenticId;
    }

    function checkWatchedMessages() {
        var stillWatching = false;
        watchedMessages.forEach(function(data, mid) {
            var el = data.element;
            if (!el || !document.contains(el)) { watchedMessages.delete(mid); return; }
            data.attempts++;
            var currentContent = (el.innerText || el.textContent || '');
            var contentChanged = (currentContent !== data.lastContent);
            data.lastContent = currentContent;
            var isStreamingNow = isStreaming(el);
            var shouldProcess = (!isStreamingNow && !contentChanged) || data.attempts >= data.maxAttempts;
            if (shouldProcess && !processingQueue.has(mid)) {
                processingQueue.add(mid);
                setTimeout(function() {
                    processMessage(el);
                    processingQueue.delete(mid);
                    if (el.dataset.agenticProcessed === 'full' || data.attempts >= data.maxAttempts) watchedMessages.delete(mid);
                }, 100);
            }
            if (data.attempts < data.maxAttempts) stillWatching = true;
        });
        if (!stillWatching && watchedMessages.size === 0) { clearInterval(streamCheckInterval); streamCheckInterval = null; }
    }

    // ── Message Detection ──────────────────────────────────────
    function isLastMessage(el) {
        var selectors = ['.ds-markdown', '.ds-markdown-block', '.ds-message', '[class*="message"]', '[class*="chat-item"]', '[class*="bubble"]', '[class*="markdown"]', '[class*="ds-chat"] article', '[class*="chat-turn"]', 'article'];
        var allMessages = [];
        for (var s = 0; s < selectors.length; s++) {
            try {
                var found = document.querySelectorAll(selectors[s]);
                for (var f = 0; f < found.length; f++) {
                    if (isVisible(found[f]) && allMessages.indexOf(found[f]) === -1) allMessages.push(found[f]);
                }
            } catch (e) {}
        }
        if (allMessages.length === 0) return true;
        allMessages.sort(function(a, b) { return a.getBoundingClientRect().top - b.getBoundingClientRect().top; });
        var lastMsg = allMessages[allMessages.length - 1];
        return (el === lastMsg || (lastMsg && lastMsg.contains(el)) || el.contains(lastMsg));
    }

    function scanAllMessages() {
        var selectors = ['.ds-markdown', '.ds-markdown-block', 'article', '[class*="message"]', '[class*="chat-item"]'];
        for (var s = 0; s < selectors.length; s++) {
            try {
                var els = document.querySelectorAll(selectors[s]);
                for (var i = 0; i < els.length; i++) {
                    if (els[i].offsetParent) processMessage(els[i]);
                }
            } catch (e) {}
        }
    }

    function processMessage(el) {
        if (el.querySelector('.agentic-script-badge') || el.dataset.agenticProcessed === 'done') return;
        var scripts = extractScripts(el);
        if (!scripts.length) return;
        var preBlocks = el.querySelectorAll('.md-code-block, pre');
        if (!preBlocks.length) return;
        var lastPre = preBlocks[preBlocks.length - 1];
        if (!lastPre.parentNode) return;

        var container = document.createElement('div');
        container.className = 'agentic-injected-container';
        container.style.marginTop = '8px';
        logPanel('Found ' + scripts.length + ' bash script(s)', 'success');

        for (var idx = 0; idx < scripts.length; idx++) {
            var script = scripts[idx];
            if (processedScripts.has(script.hash)) continue;
            var btn = document.createElement('button');
            btn.className = 'agentic-exec-btn';
            btn.innerHTML = 'EXEC BASH';
            btn.onclick = (function(sd, button) { return function() {
                if (processedScripts.has(sd.hash)) return;
                var sid = 's-' + Date.now();
                var cmd = "cat > /tmp/ds_" + sid + ".sh << 'EOF'\n" + sd.content + "\nEOF\nchmod +x /tmp/ds_" + sid + ".sh\n/tmp/ds_" + sid + ".sh";
                if (executeScript(cmd, sid)) { processedScripts.add(sd.hash); button.innerHTML = 'SENT'; button.className = 'agentic-exec-btn sent'; }
            }; })(script, btn);
            var badge = document.createElement('div');
            badge.className = 'agentic-script-badge';
            badge.textContent = 'BASH SCRIPT DETECTED';
            container.appendChild(badge);
            container.appendChild(btn);
            if (isAutoExec && !processedScripts.has(script.hash) && isLastMessage(el)) {
                setTimeout(function() { btn.click(); }, 500);
            }
        }
        el.dataset.agenticProcessed = 'done';
        lastPre.parentNode.insertBefore(container, lastPre.nextSibling);
    }

    // ── DOM Observer ───────────────────────────────────────────
function initObserver() {
    var actionObserver = new MutationObserver(function(mutations) {
        for (var i = 0; i < mutations.length; i++) {
            for (var j = 0; j < mutations[i].addedNodes.length; j++) {
                var node = mutations[i].addedNodes[j];
                if (node.nodeType === 1 && node.classList && node.classList.contains("ds-flex")) {
                    var svg = node.querySelector("svg");
                    if (svg) {
                        logPanel("AI finished, scanning...", "info");
                        setTimeout(function() { scanAllMessages(); }, 500);
                        return;
                    }
                }
            }
        }
    });
    actionObserver.observe(document.body, { childList: true, subtree: true });
    scanAllMessages();
    logPanel("Observer initialized (action bar watch)", "info");
}

    // ── Init ───────────────────────────────────────────────────
    createPanel();
    connectWS();
    initObserver();
})();
