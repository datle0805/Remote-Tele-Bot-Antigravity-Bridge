/* ANTIGRAVITY TELEGRAM BRIDGE (V13.6 - TAILWIND FIX) */
(function () {
    const CONFIG = {
      token: "YOUR_TELEGRAM_BOT_TOKEN", 
      chatId: "YOUR_TELEGRAM_CHAT_ID",
    };
    let lastUpdateId = 0, isWaitingForAgent = false, lastHandledUpdateId = 0;
    let pollIsRunning = false, streamRound = 0;
    let telegramUpdateQueue = Promise.resolve();
    let isChatActive = true;

    const COMMANDS_HELP = `🤖 DANH SÁCH LỆNH:
/chat on : Bật chat với Agent
/chat off: Tắt chat với Agent
/quota   : Xem hạn mức
/debug   : Debug DOM
/list    : Xem danh sách này`;

    let streamState = { messageIds: [], lastFullText: "", lastSendTime: 0, pendingSend: false };
    const THROTTLE_MS = 800;

    // ================================================================
    // [SCOPE] - conversation DIV là root
    // ================================================================
    function getAgentScope() {
        const el = document.getElementById('conversation')
            || document.querySelector('[id*="conversation" i]');
        if (el) {
            if (el.tagName.toLowerCase() === 'iframe') {
                const iDoc = el.contentDocument || el.contentWindow.document;
                return { root: iDoc.body || iDoc.documentElement, doc: iDoc };
            }
            return { root: el, doc: document };
        }
        for (const iframe of document.querySelectorAll('iframe')) {
            try {
                const iDoc = iframe.contentDocument || iframe.contentWindow.document;
                if (iDoc?.querySelector('[contenteditable="true"]') || iDoc?.querySelector('textarea')) {
                    return { root: iDoc.body, doc: iDoc };
                }
            } catch (e) { }
        }
        return { root: document.body, doc: document };
    }

    // ================================================================
    // ⭐ [SEND BUTTON] - Tìm bằng text "Send" (Tailwind UI ko có aria-label)
    // ================================================================
    function findSendButton(root) {
        for (const btn of root.querySelectorAll('button')) {
            const txt = (btn.innerText || btn.textContent || '').trim().toLowerCase();
            if (txt === 'send') return btn;
        }
        // Fallback aria-label/tooltip
        return root.querySelector('button[aria-label*="Send" i], button[data-tooltip-id*="send" i], button[title*="Send" i]');
    }

    // ================================================================
    // ⭐ [STOP BUTTON] - Tailwind: không aria-label, dùng text/svg
    // ================================================================
    function isAgentBusy(root) {
        for (const btn of root.querySelectorAll('button')) {
            const txt = (btn.innerText || btn.textContent || '').trim().toLowerCase();
            if (txt === 'stop' || txt.includes('stop')) return true;
            const label = (btn.getAttribute('aria-label') || '').toLowerCase();
            if (label.includes('stop') && btn.offsetParent !== null) return true;
        }
        return false;
    }

    // ================================================================
    // ⭐ [MESSAGE CONTENT] - Lấy nội dung chat từ conversation DIV
    // Ưu tiên: chat element có nhiều p nhất → fallback: tất cả p
    // ================================================================
    function getAgentMessageText(root) {
        // Thử lấy vùng chat (phần tử trung gian chứa nhiều p nhất)
        const chatEls = root.querySelectorAll('[class*="chat" i]');
        let bestEl = null, maxP = 0;
        for (const el of chatEls) {
            const pCount = el.querySelectorAll('p').length;
            if (pCount > maxP) { maxP = pCount; bestEl = el; }
        }

        if (bestEl && maxP > 0) {
            // Lấy text của tất cả p bên trong vùng chat, ghép lại
            const paragraphs = Array.from(bestEl.querySelectorAll('p'));
            return paragraphs.map(p => (p.innerText || p.textContent || '').trim()).filter(Boolean).join('\n\n');
        }

        // Fallback: lấy toàn bộ p trong root
        const allP = Array.from(root.querySelectorAll('p'));
        return allP.map(p => (p.innerText || p.textContent || '').trim()).filter(Boolean).join('\n\n');
    }

    // ================================================================
    // [QUOTA]
    // ================================================================
    function getQuotaInfo() {
        const items = document.querySelectorAll('[aria-label*="quota" i], [aria-label*="limit" i], a.statusbar-item-label');
        const found = [];
        for (const item of items) {
            const label = item.getAttribute('aria-label') || item.title || item.innerText || '';
            if (label.toLowerCase().includes('quota') || label.toLowerCase().includes('limit')) found.push(label.trim());
        }
        return found.length > 0 ? `📊 QUOTA:\n${[...new Set(found)].join('\n---\n')}` : "❌ Không tìm thấy Quota.";
    }

    // ================================================================
    // [DEBUG]
    // ================================================================
    function runDebug() {
        const { root } = getAgentScope();
        let report = `🔍 DEBUG V13.6:\nRoot: ${root.tagName}#${root.id || 'none'}\n\n`;

        const input = root.querySelector('[contenteditable="true"]') || root.querySelector('textarea');
        report += input ? `✅ Input: ${input.tagName}\n` : `❌ Không tìm thấy input\n`;

        const sendBtn = findSendButton(root);
        report += sendBtn ? `✅ Send button: OK\n` : `❌ Không tìm thấy Send button\n`;

        const chatEls = root.querySelectorAll('[class*="chat" i]');
        report += `\n[class*="chat"]: ${chatEls.length} phần tử\n`;
        chatEls.forEach((el, i) => {
            const pCount = el.querySelectorAll('p').length;
            const cls = el.className?.toString()?.substring(0, 60);
            report += `  [${i}] class="${cls}", p="${pCount}"\n`;
        });

        const msgText = getAgentMessageText(root);
        report += `\n📝 TEXT HIỆN TẠI (200 ký tự đầu):\n"${msgText.substring(0, 200)}"\n`;

        report += `\n🔢 p count: ${root.querySelectorAll('p').length}\n`;

        for (let i = 0; i < report.length; i += 3000) sendTelegramMessage(report.substring(i, i + 3000));
    }

    // ================================================================
    // [TELEGRAM]
    // ================================================================
    async function sendTelegramMessage(text) {
        try {
            await fetch(`https://api.telegram.org/bot${CONFIG.token}/sendMessage`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: CONFIG.chatId, text })
            });
        } catch (e) { console.error('Telegram error:', e.message); }
    }

    function updateTelegram(fullText) {
        if (!fullText) return;
        telegramUpdateQueue = telegramUpdateQueue.then(() => _updateNow(fullText)).catch(() => { });
    }

    async function _updateNow(fullText) {
        const chunks = [];
        for (let i = 0; i < fullText.length; i += 4000) chunks.push(fullText.substring(i, i + 4000));
        for (let i = 0; i < chunks.length; i++) {
            const msgId = streamState.messageIds[i];
            try {
                if (!msgId) {
                    const res = await fetch(`https://api.telegram.org/bot${CONFIG.token}/sendMessage`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chat_id: CONFIG.chatId, text: chunks[i] })
                    });
                    const d = await res.json();
                    if (d.ok) streamState.messageIds[i] = d.result.message_id;
                } else {
                    await fetch(`https://api.telegram.org/bot${CONFIG.token}/editMessageText`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chat_id: CONFIG.chatId, message_id: msgId, text: chunks[i] })
                    });
                }
            } catch (e) { }
        }
    }

    // ================================================================
    // [COMMANDS]
    // ================================================================
    function handleCommand(text) {
        const cmd = text.trim().toLowerCase();
        if (cmd === '/chat on') { isChatActive = true; sendTelegramMessage("✅ Đã BẬT chat."); }
        else if (cmd === '/chat off') { isChatActive = false; sendTelegramMessage("⛔ Đã TẮT chat."); }
        else if (cmd === '/quota') { sendTelegramMessage(getQuotaInfo()); }
        else if (cmd === '/debug') { runDebug(); }
        else if (cmd === '/list') { sendTelegramMessage(COMMANDS_HELP); }
        else { sendTelegramMessage("❓ Lệnh không hợp lệ. /list để xem."); }
    }

    // ================================================================
    // [POLLING]
    // ================================================================
    function startPolling() {
        if (pollIsRunning) return;
        pollIsRunning = true;
        console.log("🔄 Bridge V13.6 polling.");
        poll();
    }

    async function poll() {
        if (isWaitingForAgent) { setTimeout(poll, 500); return; }
        try {
            const res = await fetch(`https://api.telegram.org/bot${CONFIG.token}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`);
            const data = await res.json();
            if (data.ok && data.result.length > 0) {
                for (const update of data.result) {
                    lastUpdateId = update.update_id;
                    if (!update.message || update.message.chat.id != CONFIG.chatId) continue;
                    if (update.update_id <= lastHandledUpdateId) continue;
                    const text = update.message.text;
                    if (!text) continue;
                    lastHandledUpdateId = update.update_id;
                    if (text.trim().startsWith('/')) { handleCommand(text); setTimeout(poll, 100); return; }
                    if (!isChatActive) { sendTelegramMessage("⛔ Chat tắt. Dùng /chat on."); setTimeout(poll, 100); return; }
                    handleTask(text); setTimeout(poll, 100); return;
                }
            }
        } catch (e) { console.error('Poll error:', e.message); }
        setTimeout(poll, 100);
    }

    // ================================================================
    // [HANDLE TASK]
    // ================================================================
    let stopCurrentStream = null;

    function handleTask(text) {
        const { root } = getAgentScope();
        if (!root) { sendTelegramMessage("❌ Không tìm thấy panel."); return; }

        const input = root.querySelector('[contenteditable="true"][data-lexical-editor="true"]')
            || root.querySelector('[contenteditable="true"]')
            || root.querySelector('textarea, input[type="text"]');
        if (!input) { sendTelegramMessage("❌ Không tìm thấy ô nhập liệu."); return; }

        isWaitingForAgent = true;
        sendTelegramMessage("⏳ Đang gửi cho Agent...");
        streamState = { messageIds: [], lastFullText: "", lastSendTime: 0, pendingSend: false };

        input.focus();
        try {
            if (input.tagName.toLowerCase() === 'textarea' || input.tagName.toLowerCase() === 'input') {
                const proto = input.tagName.toLowerCase() === 'textarea'
                    ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                if (setter) setter.call(input, text);
                else input.value = text;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
                // contenteditable div
                input.textContent = text;
                input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
            }
        } catch (e) { input.textContent = text; }

        setTimeout(() => {
            // ⭐ Dùng findSendButton thay vì aria-label
            const sendBtn = findSendButton(root);
            if (sendBtn && !sendBtn.disabled) {
                sendBtn.click();
                console.log("✅ Clicked Send");
            } else {
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                console.log("✅ Pressed Enter");
            }

            // Lấy baseline sau 700ms
            setTimeout(() => {
                const baselineText = getAgentMessageText(root);
                const baselinePCount = root.querySelectorAll('p').length;
                console.log(`📌 Baseline pCount=${baselinePCount}, text="${baselineText.substring(0, 60)}"`);
                startContentObserver(root, baselineText, baselinePCount);
            }, 700);
        }, 300);
    }

    // ================================================================
    // [OBSERVER]
    // ================================================================
    function startContentObserver(root, baselineText, baselinePCount) {
        if (stopCurrentStream) stopCurrentStream();
        streamRound++;
        let finished = false, foundNewContent = false, checkInterval = null, observer = null;

        const cleanup = () => {
            if (finished) return; finished = true;
            clearInterval(checkInterval);
            if (observer) try { observer.disconnect(); } catch (e) { }
            stopCurrentStream = null;
        };
        stopCurrentStream = cleanup;

        const onContentChange = () => {
            const currentPCount = root.querySelectorAll('p').length;
            const text = getAgentMessageText(root);
            if (!text) return;

            // Phát hiện nội dung mới: nhiều p hơn baseline HOẶC text thay đổi
            if (!foundNewContent && (currentPCount > baselinePCount || text !== baselineText)) {
                foundNewContent = true;
                console.log(`✅ Nội dung mới! pCount: ${currentPCount} / baseline: ${baselinePCount}`);
            }
            if (!foundNewContent || text === streamState.lastFullText) return;

            streamState.lastFullText = text;
            streamState.pendingSend = true;
            const now = Date.now();
            if (now - streamState.lastSendTime >= THROTTLE_MS) {
                streamState.lastSendTime = now;
                streamState.pendingSend = false;
                updateTelegram(text);
            }
        };

        try {
            observer = new MutationObserver(() => onContentChange());
            observer.observe(root, { childList: true, subtree: true, characterData: true });
        } catch (e) { }

        checkInterval = setInterval(async () => {
            if (finished) return;
            onContentChange();
            if (foundNewContent && streamState.pendingSend && Date.now() - streamState.lastSendTime >= THROTTLE_MS) {
                streamState.lastSendTime = Date.now();
                streamState.pendingSend = false;
                await updateTelegram(streamState.lastFullText);
            }
            if (!isAgentBusy(root) && isWaitingForAgent) {
                isWaitingForAgent = false;
                console.log("✅ Agent done.");
            }
            clickRunButtons(root);
        }, 500);
    }

    function clickRunButtons(root) {
        for (const btn of root.querySelectorAll('button')) {
            if (btn.hasAttribute('data-auto-clicked')) continue;
            const txt = (btn.innerText || '').trim().toLowerCase();
            if (txt.startsWith('run') && !btn.disabled) {
                btn.click();
                btn.setAttribute('data-auto-clicked', 'true');
            }
        }
    }

    console.log("🚀 BRIDGE V13.6 (TAILWIND FIX) READY.");
    startPolling();
})();
