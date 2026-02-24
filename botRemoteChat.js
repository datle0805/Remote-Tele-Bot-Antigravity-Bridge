/* ANTIGRAVITY TELEGRAM BRIDGE (V14.0 - MESSAGE EXTRACTION FIX) */
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
    // Antigravity IDE dùng Tailwind, không có class "prose"
    // Cấu trúc: div.text-ide-message-block-bot-color > các message block
    // ================================================================

    /**
     * Tìm container chứa tất cả tin nhắn trong cuộc hội thoại.
     */
    function getConversationContainer(root) {
        // 1. Tìm container chính bằng class đặc trưng
        const container = root.querySelector('.text-ide-message-block-bot-color');
        if (container) return container;

        // 2. Tìm bằng id antigravity panel rồi lấy parent conversation
        const inputBox = root.querySelector('#antigravity\\.agentSidePanelInputBox');
        if (inputBox) {
            // Đi lên tìm container conversation (thường là parent hoặc grandparent)
            let el = inputBox.parentElement;
            while (el && el !== root) {
                if (el.scrollHeight > el.clientHeight || el.classList.contains('overflow-y-auto')) {
                    return el;
                }
                el = el.parentElement;
            }
        }

        // 3. Tìm scrollable container chứa nhiều nội dung nhất
        const scrollables = root.querySelectorAll('[class*="overflow-y-auto"]');
        let best = null, bestLen = 0;
        for (const s of scrollables) {
            const len = (s.innerText || '').length;
            if (len > bestLen) { bestLen = len; best = s; }
        }
        if (best) return best;

        return root;
    }

    /**
     * Lấy danh sách các message block (mỗi block = 1 lượt trả lời của agent hoặc user).
     * Trong Antigravity IDE, mỗi message block là direct child div nằm trong
     * container chính, có chứa nội dung text thực sự.
     */
    function getAgentMessageBlocks(root) {
        const container = getConversationContainer(root);
        const blocks = [];

        // Strategy 1: Tìm các div con trực tiếp có class "relative flex flex-col mb-2"
        // (format tin nhắn trong Antigravity)
        const directChildren = container.querySelectorAll(':scope > div > div.relative.flex.flex-col');
        if (directChildren.length > 0) {
            for (const child of directChildren) {
                const text = (child.innerText || '').trim();
                // Loại bỏ: input box, placeholder text ngắn, các element rỗng
                if (text.length > 5 &&
                    !child.querySelector('[contenteditable="true"]') &&
                    !child.querySelector('#antigravity\\.agentSidePanelInputBox')) {
                    blocks.push(child);
                }
            }
            if (blocks.length > 0) return blocks;
        }

        // Strategy 2: Tìm tất cả div có chứa formatted content (markdown rendered)
        // Agent response thường có: p, pre, code, ul, ol, h1-h6
        const contentDivs = container.querySelectorAll('div');
        for (const div of contentDivs) {
            // Chỉ lấy div có nội dung markdown (chứa p, pre, code blocks, headings)
            const hasMarkdown = div.querySelector('p, pre, code, ul, ol, h1, h2, h3, h4, h5, h6');
            const text = (div.innerText || '').trim();
            if (hasMarkdown && text.length > 20 &&
                !div.querySelector('[contenteditable="true"]') &&
                !div.querySelector('#antigravity\\.agentSidePanelInputBox') &&
                !div.closest('[contenteditable="true"]')) {
                // Tránh trùng lặp: chỉ lấy div cha nhất (không nằm trong block đã chọn)
                let isDuplicate = false;
                for (const existing of blocks) {
                    if (existing.contains(div) || div.contains(existing)) {
                        isDuplicate = true;
                        if (div.contains(existing)) {
                            // Thay thế bằng div lớn hơn
                            blocks[blocks.indexOf(existing)] = div;
                        }
                        break;
                    }
                }
                if (!isDuplicate) blocks.push(div);
            }
        }

        return blocks;
    }

    function getAgentMessageText(root) {
        const blocks = getAgentMessageBlocks(root);

        if (blocks.length > 0) {
            // Lấy block cuối cùng (tin nhắn gần nhất của agent)
            const lastBlock = blocks[blocks.length - 1];
            return (lastBlock.innerText || '').trim();
        }

        // Fallback 1: Tìm div.prose (các IDE cũ hơn có thể dùng)
        const proseBlocks = root.querySelectorAll('div.prose, [class*="prose" i]');
        if (proseBlocks.length > 0) {
            return (proseBlocks[proseBlocks.length - 1].innerText || '').trim();
        }

        // Fallback 2: Tìm block có class chứa "message" hoặc "chat"
        const chatEls = root.querySelectorAll('[class*="message" i]');
        if (chatEls.length > 0) {
            // Lọc bỏ input box
            const filtered = [...chatEls].filter(el =>
                !el.querySelector('[contenteditable="true"]') &&
                (el.innerText || '').trim().length > 10
            );
            if (filtered.length > 0) {
                return (filtered[filtered.length - 1].innerText || '').trim();
            }
        }

        // Fallback 3: Lấy tất cả text từ conversation container (trừ input)
        const container = getConversationContainer(root);
        const inputBox = container.querySelector('#antigravity\\.agentSidePanelInputBox');
        if (inputBox) {
            // Clone container, remove input, lấy text
            const clone = container.cloneNode(true);
            const cloneInput = clone.querySelector('#antigravity\\.agentSidePanelInputBox');
            if (cloneInput) cloneInput.closest('div.w-full')?.remove() || cloneInput.remove();
            const text = (clone.innerText || '').trim();
            if (text.length > 5) return text;
        }

        // Fallback cuối: lấy tất cả p (trừ placeholder)
        const allP = root.querySelectorAll('p');
        const validP = [...allP].filter(p => {
            const text = (p.innerText || '').trim();
            return text.length > 2 &&
                !p.classList.contains('pointer-events-none') &&  // Bỏ placeholder
                !p.closest('[contenteditable="true"]');
        });
        if (validP.length > 0) {
            return validP.map(p => (p.innerText || '').trim()).join('\n');
        }

        return '';
    }

    function getMessageBlockCount(root) {
        const blocks = getAgentMessageBlocks(root);
        if (blocks.length > 0) return blocks.length;

        // Fallback
        const proseBlocks = root.querySelectorAll('div.prose, [class*="prose" i]');
        return proseBlocks.length;
    }

    // ================================================================
    // [QUOTA]
    // ================================================================
    function getQuotaInfo() {
        // 1. Tìm trong thanh trạng thái ngoài (statusbar)
        const items = document.querySelectorAll('a.statusbar-item-label, .status-bar-item');
        const found = [];

        for (const item of items) {
            const label = item.getAttribute('aria-label') || item.title || item.innerText || '';
            const lower = label.toLowerCase();
            if (lower.includes('quota') || lower.includes('limit') || lower.includes('hạn mức')) {
                found.push(label.trim());
            }
        }

        // 2. Fallback: tìm trong tất cả iframe (thay thế antigravity.agentPanel cũ)
        if (found.length === 0) {
            for (const iframe of document.querySelectorAll('iframe')) {
                try {
                    const iDoc = iframe.contentDocument || iframe.contentWindow.document;
                    const iframeItems = iDoc.querySelectorAll(
                        'a.statusbar-item-label, [aria-label*="quota" i], [aria-label*="limit" i], [aria-label*="requests" i]'
                    );
                    for (const item of iframeItems) {
                        const label = item.getAttribute('aria-label') || item.title || item.innerText || '';
                        if (label) found.push(label.trim());
                    }
                } catch (e) { }
            }
        }

        if (found.length > 0) {
            // Ưu tiên item chứa "antigravity", nếu không có thì hiện tất cả
            const antigravityItems = [...new Set(found)].filter(s => s.toLowerCase().includes('antigravity'));
            const display = antigravityItems.length > 0 ? antigravityItems : [...new Set(found)];
            return `📊 THÔNG TIN HẠN MỨC (QUOTA):\n\n${display.join('\n---\n')}`;
        }

        return '❌ Không tìm thấy thông tin hạn mức (Quota). Hãy đảm bảo bạn đang mở IDE Antigravity.';
    }

    // ================================================================
    // [DEBUG]
    // ================================================================
    function runDebug() {
        const { root } = getAgentScope();
        let report = `🔍 DEBUG V14.0:\nRoot: ${root.tagName}#${root.id || 'none'}\n\n`;

        const input = root.querySelector('[contenteditable="true"]') || root.querySelector('textarea');
        report += input ? `✅ Input: ${input.tagName}\n` : `❌ Không tìm thấy input\n`;

        const sendBtn = findSendButton(root);
        report += sendBtn ? `✅ Send button: OK\n` : `❌ Không tìm thấy Send button\n`;

        // Conversation container
        const container = getConversationContainer(root);
        report += `\n📦 Container: ${container.tagName}`;
        report += container.className ? `.${container.className.toString().substring(0, 80)}` : '';
        report += `\n`;

        // Message blocks
        const blocks = getAgentMessageBlocks(root);
        report += `\n💬 Message blocks: ${blocks.length}\n`;
        blocks.forEach((block, i) => {
            const text = (block.innerText || '').trim();
            const cls = block.className?.toString()?.substring(0, 60) || 'none';
            report += `  [${i}] class="${cls}", len=${text.length}, preview="${text.substring(0, 80)}"\n`;
        });

        // Agent message text
        const msgText = getAgentMessageText(root);
        report += `\n📝 AGENT TEXT (500 ký tự đầu):\n"${msgText.substring(0, 500)}"\n`;
        report += `\n📝 AGENT TEXT tổng length: ${msgText.length}\n`;

        // DOM stats
        report += `\n🔢 Tổng p: ${root.querySelectorAll('p').length}`;
        report += `\n🔢 contenteditable: ${root.querySelectorAll('[contenteditable="true"]').length}`;
        report += `\n🔢 [class*="bot-color"]: ${root.querySelectorAll('[class*="bot-color"]').length}`;
        report += `\n🔢 antigravity input: ${root.querySelector('#antigravity\\.agentSidePanelInputBox') ? 'CÓ' : 'KHÔNG'}`;
        report += `\n`;

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
        console.log("🔄 Bridge V14.0 polling.");
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
                const baselineCount = getMessageBlockCount(root);
                console.log(`📌 Baseline blocks=${baselineCount}, text="${baselineText.substring(0, 60)}"`);
                startContentObserver(root, baselineText, baselineCount);
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
            const currentCount = getMessageBlockCount(root);
            const text = getAgentMessageText(root);
            if (!text) return;

            // Phát hiện nội dung mới: nhiều block hơn baseline HOẶC text thay đổi
            if (!foundNewContent && (currentCount > baselinePCount || text !== baselineText)) {
                foundNewContent = true;
                console.log(`✅ Nội dung mới! blocks: ${currentCount} / baseline: ${baselinePCount}`);
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

    console.log("🚀 BRIDGE V14.0 (MESSAGE EXTRACTION FIX) READY.");
    startPolling();
})();
