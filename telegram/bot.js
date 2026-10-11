const crypto = require('crypto');
const path = require('path');
const { Bot, InlineKeyboard, InputFile } = require('grammy');

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const RESULT_PATTERN = /^result_(business|personal|unregistered)_(.+)\.txt$/;
const ACTION_TTL_MS = 10 * 60 * 1000;
const LIST_PAGE_SIZE = 6;
const PAIRING_REFRESH_INTERVAL_MS = 500;
const PAIRING_REFRESH_MAX_DURATION_MS = 185000;
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const MAX_SCAN_SENDER_DETAILS = 3;
const BUTTON_STYLE = Object.freeze({
    primary: 'primary',
    success: 'success',
    danger: 'danger'
});
const TELEGRAM_COMMANDS = Object.freeze([
    { command: 'start', description: 'Open the button menu' },
    { command: 'shutdown', description: 'Stop the local application' }
].map(command => Object.freeze(command)));
const SHUTDOWN_NOTICE = 'The local cekbio application is shutting down.';

const editShutdownNotice = updateMessage => updateMessage(
    SHUTDOWN_NOTICE,
    { reply_markup: { inline_keyboard: [] } }
);

const validateTelegramConfig = ({ token, ownerId }) => {
    if (typeof token !== 'string' || !token.trim()) {
        throw new Error('Set TELEGRAM_BOT_TOKEN in the local .env file before starting Telegram mode.');
    }
    if (typeof ownerId !== 'string' || !/^\d+$/.test(ownerId)
        || !Number.isSafeInteger(Number(ownerId)) || Number(ownerId) < 1) {
        throw new Error('Set TELEGRAM_OWNER_ID to your numeric Telegram user ID in the local .env file.');
    }
};

const isResultFilename = filename => typeof filename === 'string'
    && path.basename(filename) === filename
    && RESULT_PATTERN.test(filename);

const getTargetDisplayName = filename => filename
    .replace(/^target_/, '')
    .replace(/\.txt$/i, '');

const formatTargetButtonLabel = filename => getTargetDisplayName(filename);

const formatSenderButtonLabel = folder => folder;

const getSenderButtonStyle = status => {
    if (['alive', 'active', 'scanning'].includes(status)) return BUTTON_STYLE.success;
    if (status === 'checking' || status === 'unknown' || status == null) return BUTTON_STYLE.primary;
    return BUTTON_STYLE.danger;
};

const getTargetButtonStyle = isSelected => isSelected ? BUTTON_STYLE.success : BUTTON_STYLE.danger;

const getActionButtonStyle = (label, payload) =>
    label === 'Remove' || label.startsWith('Remove ') || label === 'Cancel'
        ? BUTTON_STYLE.danger
        : BUTTON_STYLE.primary;

const isMessageNotModifiedError = error =>
    /message is not modified/i.test(error?.description || error?.message || '');

const isDashboardUneditableError = error =>
    /message to edit not found|message can't be edited|message identifier is not specified/i
        .test(error?.description || error?.message || '');

const createDashboardPresenter = ({ sendMessage, editMessageText, editMessageReplyMarkup }) => {
    const messageIds = new Map();
    return {
        async present(chatId, preferredMessageId, text, replyMarkup) {
            let messageId = messageIds.get(chatId) || preferredMessageId;
            const options = { reply_markup: replyMarkup };
            if (messageId) {
                try {
                    await editMessageText(chatId, messageId, text, options);
                    messageIds.set(chatId, messageId);
                    return { message_id: messageId };
                } catch (error) {
                    if (isMessageNotModifiedError(error)) {
                        messageIds.set(chatId, messageId);
                        return { message_id: messageId };
                    }
                    if (!isDashboardUneditableError(error)) throw error;
                    if (messageIds.get(chatId) === messageId) messageIds.delete(chatId);
                }
            }
            const message = await sendMessage(chatId, text, options);
            if (!message?.message_id) throw new Error('Telegram did not return a dashboard message ID.');
            messageIds.set(chatId, message.message_id);
            return message;
        },
        async updateReplyMarkup(chatId, preferredMessageId, replyMarkup) {
            const messageId = messageIds.get(chatId) || preferredMessageId;
            if (!messageId) throw new Error('Telegram dashboard message ID is not available.');
            await editMessageReplyMarkup(chatId, messageId, { reply_markup: replyMarkup });
            messageIds.set(chatId, messageId);
            return { message_id: messageId };
        },
        getMessageId(chatId) {
            return messageIds.get(chatId) || null;
        },
        clear() {
            messageIds.clear();
        }
    };
};

const formatSenderSessionsText = (page, pageCount, senderCount) => [
    '👤 Sender sessions',
    '',
    'Green = Active · Blue = Checking · Red = Inactive',
    ...(pageCount > 1 ? [`Page ${page + 1} of ${pageCount}`] : []),
    ...(senderCount ? [] : ['', 'No sender sessions found. Add a sender from the Senders menu.'])
].join('\n');

const limitText = (value, maxLength) => {
    const text = String(value ?? '');
    if (text.length <= maxLength) return text;
    let result = '';
    let length = 0;
    for (const character of text) {
        if (length + character.length > maxLength - 1) break;
        result += character;
        length += character.length;
    }
    return `${result}…`;
};

const formatScanProgress = scan => {
    if (!scan) return '🔎 Scan progress\n\nNo scan information is available.';
    const totalTargets = scan.totalTargets || 0;
    const completedTargets = Math.min(scan.completedTargets || 0, totalTargets);
    const activeTargets = (scan.activeBatchProgress || []).reduce(
        (total, progress) => total + Math.min(progress.processedTargets || 0, progress.totalTargets || 0),
        0
    );
    const displayedTargets = Math.min(completedTargets + activeTargets, totalTargets);
    const percentage = totalTargets ? Math.floor((displayedTargets / totalTargets) * 100) : 0;
    const filled = Math.floor(percentage / 10);
    const progressBar = `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
    const lines = [
        '🔎 Scan progress',
        '',
        `Target: ${limitText(scan.targetFile, 180)}`,
        `${progressBar} ${percentage}%`,
        `Targets confirmed: ${completedTargets} / ${totalTargets}`,
        ...(activeTargets
            ? [`Currently processing: ${activeTargets} / ${Math.max(totalTargets - completedTargets, 0)}`]
            : []),
        `Batches: ${scan.completedBatches || 0} / ${scan.totalBatches || 0}`,
        `Status: ${limitText(scan.status || 'starting', 80)}`
    ];

    if (scan.status === 'starting') lines.push('', 'Checking and preparing sender sessions…');
    const activeBatchProgress = scan.activeBatchProgress || [];
    for (const progress of activeBatchProgress.slice(0, MAX_SCAN_SENDER_DETAILS)) {
        const batchProgress = `${progress.processedTargets || 0} / ${progress.totalTargets || 0}`;
        lines.push(
            `${limitText(progress.folder, 100)}: batch ${(progress.batchIndex || 0) + 1}/${progress.totalBatches} · ${batchProgress} targets`
        );
        if (progress.phase && progress.phase !== 'batch complete') {
            lines.push(`  ${limitText(progress.phase, 100)}…`);
        }
    }
    if (activeBatchProgress.length > MAX_SCAN_SENDER_DETAILS) {
        lines.push(`+${activeBatchProgress.length - MAX_SCAN_SENDER_DETAILS} more active senders`);
    }
    if (scan.senderStatuses) {
        const activeSenders = Object.values(scan.senderStatuses)
            .filter(sender => ['active', 'scanning'].includes(sender.status)).length;
        lines.push(`Active senders: ${activeSenders} / ${scan.sessionFolders?.length || 0}`);
        const inactive = Object.entries(scan.senderStatuses)
            .filter(([, sender]) => sender.status === 'inactive')
            .map(([folder]) => folder);
        if (inactive.length) {
            lines.push(`Excluded: ${inactive.slice(0, 5).map(folder => limitText(folder, 60)).join(', ')}`);
        }
    }
    if (scan.status === 'paused') lines.push('', 'Scan paused. Progress is saved; resume it from Scan.');
    if (scan.status === 'completed') lines.push('', 'Scan completed successfully.');
    if (scan.status === 'failed' && scan.error) lines.push('', `Error: ${limitText(scan.error, 800)}`);
    const text = lines.join('\n');
    return text.length <= TELEGRAM_MAX_MESSAGE_LENGTH
        ? text
        : limitText(text, TELEGRAM_MAX_MESSAGE_LENGTH);
};

const createActiveTargetSelection = () => {
    let activeTarget = null;
    return {
        get() {
            return activeTarget;
        },
        select(filename, availableTargets) {
            if (!availableTargets.includes(filename)) throw new Error('Target list not found.');
            activeTarget = filename;
            return activeTarget;
        },
        reconcile(availableTargets) {
            if (activeTarget && !availableTargets.includes(activeTarget)) activeTarget = null;
            return activeTarget;
        },
        clear() {
            activeTarget = null;
        }
    };
};

const addPairingCodeCopyButton = (keyboard, pairingCode) => {
    keyboard.copyText(
        { text: `🔑 ${pairingCode}`, style: BUTTON_STYLE.primary },
        pairingCode
    ).row();
    return keyboard;
};

const buildStatusKeyboard = ({ pairingCode, callbackData }) => {
    const keyboard = new InlineKeyboard();
    if (pairingCode) addPairingCodeCopyButton(keyboard, pairingCode);
    keyboard.text(
        { text: '🏠 Main menu', style: BUTTON_STYLE.primary },
        callbackData({ type: 'main-menu' })
    );
    return keyboard;
};

const formatResultButtonLabel = filename => {
    const match = typeof filename === 'string' ? filename.match(RESULT_PATTERN) : null;
    return match ? `${match[1]} ${match[2].replace(/_/g, ' ')}` : String(filename);
};

const buildConfirmationKeyboard = (callbackData, action, returnTo) => {
    const keyboard = new InlineKeyboard();
    keyboard.text(
        { text: '✅ Confirm', style: getActionButtonStyle('✅ Confirm', { type: 'confirm' }) },
        callbackData({ type: 'confirm', action, returnTo })
    );
    keyboard.text(
        { text: 'Cancel', style: getActionButtonStyle('Cancel', { type: 'cancel' }) },
        callbackData({ type: 'cancel', returnTo })
    );
    return keyboard;
};

const buildScanProgressKeyboard = (callbackData, results = [], requestedPage = 0) => {
    const keyboard = new InlineKeyboard();
    const { page, pageCount, items } = paginateItems(results, requestedPage);
    for (const filename of items) {
        keyboard.text(
            { text: [...formatResultButtonLabel(filename)].slice(0, 60).join(''), style: BUTTON_STYLE.primary },
            callbackData({ type: 'send-result', filename, page })
        ).row();
    }
    if (pageCount > 1) {
        if (page > 0) keyboard.text(
            { text: '⬅️ Previous', style: BUTTON_STYLE.primary },
            callbackData({ type: 'scan-result-page', page: page - 1 })
        );
        if (page + 1 < pageCount) keyboard.text(
            { text: 'Next ➡️', style: BUTTON_STYLE.primary },
            callbackData({ type: 'scan-result-page', page: page + 1 })
        );
        keyboard.row();
    }
    keyboard.text(
        { text: '🏠 Main menu', style: BUTTON_STYLE.primary },
        callbackData({ type: 'main-menu' })
    );
    return keyboard;
};

const isPairingInProgress = sender => sender?.status === 'running'
    && !sender.mode
    && (!sender.sessionFolder || Boolean(sender.pairingCode));

const shouldContinuePairingRefresh = (sender, expiresAt, now = Date.now()) =>
    isPairingInProgress(sender) && now < expiresAt;

const getVisiblePairingCode = sender =>
    isPairingInProgress(sender) && typeof sender.pairingCode === 'string'
        ? sender.pairingCode
        : null;

const buildMainMenuKeyboard = ({ targets, activeTarget, page, callbackData, scanStatus }) => {
    const keyboard = new InlineKeyboard();
    const { page: currentPage, pageCount, items } = paginateItems(targets, page);
    const addButton = (label, payload, style = BUTTON_STYLE.primary) =>
        keyboard.text(
            { text: [...String(label)].slice(0, 60).join(''), style },
            callbackData(payload)
        );

    addButton('👤 Senders', { type: 'show-senders', page: 0, probeHealth: true });
    const scanInProgress = ['starting', 'running'].includes(scanStatus);
    addButton(
        scanInProgress ? '🔎 Scan progress' : '🔎 Scan',
        scanInProgress ? { type: 'scan-progress-refresh' } : { type: 'show-scan', page: 0 }
    ).row();
    addButton('📦 Results', { type: 'show-results', page: 0 }).row();
    addButton('⬆️ Upload Targets', { type: 'upload-targets', page: currentPage }).row();

    for (const target of items) {
        addButton(
            formatTargetButtonLabel(target),
            { type: 'select-target', filename: target, page: currentPage, returnToMain: true },
            getTargetButtonStyle(target === activeTarget)
        ).row();
    }

    if (pageCount > 1) {
        if (currentPage > 0) {
            addButton('⬅️ Previous', { type: 'main-menu-page', page: currentPage - 1 });
        }
        if (currentPage + 1 < pageCount) {
            addButton('Next ➡️', { type: 'main-menu-page', page: currentPage + 1 });
        }
        keyboard.row();
    }
    addButton('⏻ Shutdown', { type: 'shutdown' });
    return keyboard;
};

const buildSenderSessionsKeyboard = ({ senders, statuses, page, pageCount, callbackData }) => {
    const keyboard = new InlineKeyboard();
    const addButton = (label, payload, style = BUTTON_STYLE.primary) =>
        keyboard.text({ text: label, style }, callbackData(payload));
    addButton('➕ Add sender', { type: 'add-sender' }).row();
    for (const folder of senders) {
        const status = statuses.get(folder)?.status;
        addButton(formatSenderButtonLabel(folder), {
            type: 'refresh-senders',
            page
        }, getSenderButtonStyle(status)).row();
        addButton('Remove', {
            type: 'confirm',
            action: { type: 'delete-sender', folder },
            returnTo: { type: 'show-senders', page }
        }, BUTTON_STYLE.danger).row();
    }
    if (pageCount > 1) {
        if (page > 0) addButton('⬅️ Previous', { type: 'show-senders', page: page - 1 });
        if (page + 1 < pageCount) addButton('Next ➡️', { type: 'show-senders', page: page + 1 });
        keyboard.row();
    }
    addButton('🏠 Main menu', { type: 'main-menu' });
    return keyboard;
};

const buildResultsKeyboard = ({ results, page, pageCount, callbackData }) => {
    const keyboard = new InlineKeyboard();
    const addButton = (label, payload, style = BUTTON_STYLE.primary) =>
        keyboard.text(
            { text: [...String(label)].slice(0, 60).join(''), style },
            callbackData(payload)
        );

    for (const filename of results) {
        addButton(formatResultButtonLabel(filename), { type: 'send-result', filename, page });
        addButton('Remove', {
            type: 'request-result-removal-confirmation',
            action: { type: 'delete-result', filename },
            returnTo: { type: 'show-results', page, message: 'Removal cancelled.' }
        }, BUTTON_STYLE.danger).row();
    }
    if (pageCount > 1) {
        if (page > 0) addButton('⬅️ Previous', { type: 'show-results', page: page - 1 });
        if (page + 1 < pageCount) addButton('Next ➡️', { type: 'show-results', page: page + 1 });
        keyboard.row();
    }
    addButton('🏠 Main menu', { type: 'main-menu' });
    return keyboard;
};

const formatMainMenuText = (message, page, pageCount, targetCount) => {
    const targetGuidance = targetCount
        ? 'Select one target below, or upload a new list.'
        : 'Upload a .txt or .xlsx document to add a target list.';
    return [
        'cekbio',
        '',
        message,
        '',
        'Targets',
        targetGuidance,
        ...(pageCount > 1 ? [`Page ${page + 1} of ${pageCount}`] : [])
    ].join('\n');
};

const isAuthorizedUpdate = (ctx, ownerId) => Boolean(ctx.from
    && ctx.chat?.type === 'private'
    && ctx.chat.id === ctx.from.id
    && String(ctx.from.id) === String(ownerId));

const acknowledgeCallbackQuery = async ctx => {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
};

const acknowledgeCallbackQueryWithoutWaiting = (
    ctx,
    onError = error => console.error('Telegram callback acknowledgement failed:', error.message)
) => {
    if (!ctx.callbackQuery) return;
    try {
        Promise.resolve(ctx.answerCallbackQuery()).catch(onError);
    } catch (error) {
        onError(error);
    }
};

const shouldProbeSenderHealth = ({ command, action } = {}) =>
    command === 'start' || (action?.type === 'show-senders' && action.probeHealth === true);

const paginateItems = (items, requestedPage, pageSize = LIST_PAGE_SIZE) => {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error('Page size must be a positive integer.');
    const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
    const page = Math.max(0, Math.min(Number.isSafeInteger(requestedPage) ? requestedPage : 0, pageCount - 1));
    return {
        page,
        pageCount,
        items: items.slice(page * pageSize, (page + 1) * pageSize)
    };
};

const createActionRegistry = (now = Date.now) => {
    const entries = new Map();
    return {
        create(payload) {
            for (const [key, entry] of entries) {
                if (entry.expiresAt <= now()) entries.delete(key);
            }
            const key = crypto.randomBytes(6).toString('hex');
            entries.set(key, { payload, expiresAt: now() + ACTION_TTL_MS });
            return `a:${key}`;
        },
        consume(callbackData) {
            const match = /^a:([a-f0-9]{12})$/.exec(callbackData || '');
            if (!match) return null;
            const entry = entries.get(match[1]);
            entries.delete(match[1]);
            if (!entry || entry.expiresAt <= now()) return null;
            return entry.payload;
        },
        get size() {
            return entries.size;
        }
    };
};

const startTelegramBot = async ({ token, ownerId, service, onError = () => {} }) => {
    validateTelegramConfig({ token, ownerId });
    ownerId = String(Number(ownerId));
    if (!service) throw new Error('A local application service is required to start the Telegram bot.');

    const bot = new Bot(token);
    const dashboard = createDashboardPresenter({
        sendMessage: (chatId, text, options) => bot.api.sendMessage(chatId, text, options),
        editMessageText: (chatId, messageId, text, options) =>
            bot.api.editMessageText(chatId, messageId, text, options),
        editMessageReplyMarkup: (chatId, messageId, options) =>
            bot.api.editMessageReplyMarkup(chatId, messageId, options)
    });
    const actions = createActionRegistry();
    const activeTargetSelection = createActiveTargetSelection();
    const pendingBatchSizes = new Map();
    const pendingSenderNumbers = new Map();
    const pairingRefreshTimers = new Map();
    const pairingRefreshErrors = new Set();
    const senderViewRefreshes = new Map();
    const senderViewTokens = new Map();
    const senderHealthErrors = new Set();
    const scanProgressRefreshes = new Map();
    const scanProgressErrors = new Set();

    const scheduleSenderHealthCheck = chatId => {
        const key = String(chatId);
        service.getSenderHealth()
            .then(() => senderHealthErrors.delete(key))
            .catch(error => {
                if (!senderHealthErrors.has(key)) {
                    senderHealthErrors.add(key);
                    console.error('Automatic sender health check failed:', error.message);
                }
            });
    };

    const registerAction = (payload) => {
        return actions.create(payload);
    };

    const actionButton = (keyboard, label, payload) => {
        keyboard.text(
            {
                text: [...String(label)].slice(0, 60).join(''),
                style: getActionButtonStyle(String(label), payload)
            },
            registerAction(payload)
        );
        return keyboard;
    };

    const clearSenderViewRefresh = chatId => {
        const refresh = senderViewRefreshes.get(chatId);
        if (refresh) clearTimeout(refresh.timer);
        senderViewRefreshes.delete(chatId);
        senderViewTokens.delete(chatId);
    };

    const clearScanProgressRefresh = chatId => {
        const key = String(chatId);
        const refresh = scanProgressRefreshes.get(key);
        if (refresh) clearTimeout(refresh.timer);
        scanProgressRefreshes.delete(key);
        scanProgressErrors.delete(key);
    };

    const present = (ctx, text, replyMarkup) => {
        const chatId = ctx.chat?.id;
        if (!chatId) throw new Error('A private chat is required to show the Telegram dashboard.');
        clearSenderViewRefresh(chatId);
        clearScanProgressRefresh(chatId);
        clearPairingRefresh(chatId);
        return dashboard.present(
            chatId,
            ctx.callbackQuery?.message?.message_id,
            text,
            replyMarkup
        );
    };

    const clearPairingRefresh = (chatId, clearErrors = true) => {
        const refresh = pairingRefreshTimers.get(chatId);
        if (refresh) {
            refresh.active = false;
            clearTimeout(refresh.timer);
        }
        pairingRefreshTimers.delete(chatId);
        if (clearErrors) pairingRefreshErrors.delete(chatId);
    };

    const mainMenuKeyboard = (targets, activeTarget, page, scanStatus) => {
        return buildMainMenuKeyboard({
            targets,
            activeTarget,
            page,
            callbackData: registerAction,
            scanStatus
        });
    };

    const addMenuButton = (keyboard, label = '🏠 Main menu') => {
        actionButton(keyboard, label, { type: 'main-menu' });
        return keyboard;
    };

    const showMainMenu = async (ctx, message = 'What would you like to do?', page = 0) => {
        clearSenderViewRefresh(ctx.chat?.id);
        if (ctx.chat?.id) clearPairingRefresh(ctx.chat.id);
        const targets = service.getTargetNames();
        const { scan } = service.getStatus();
        const activeTarget = activeTargetSelection.reconcile(targets);
        const { page: currentPage, pageCount } = paginateItems(targets, page);
        const text = formatMainMenuText(message, currentPage, pageCount, targets.length);
        return present(ctx, text, mainMenuKeyboard(targets, activeTarget, currentPage, scan?.status));
    };

    const createStatusPresentation = (scan, sender, message, includePairingCode = true) => {
        const pairingCode = includePairingCode ? getVisiblePairingCode(sender) : null;
        const lines = [`📊 cekbio status`, `Scan: ${scan?.status || 'idle'}`];
        if (message) lines.push(message);
        if (scan) {
            lines.push(`Target: ${scan.targetFile}`);
            if (scan.sessionFolders?.length) {
                lines.push(`Sender sessions: ${scan.sessionFolders.length}`);
            } else if (scan.sessionFolder) {
                lines.push(`Sender: ${scan.sessionFolder}`);
            }
            lines.push(`Progress: ${scan.completedTargets} / ${scan.totalTargets} targets`);
            if (scan.senderStatuses) {
                const activeCount = Object.values(scan.senderStatuses)
                    .filter(sender => ['active', 'scanning'].includes(sender.status)).length;
                lines.push(`Active scan senders: ${activeCount} / ${scan.sessionFolders.length}`);
                const unavailableSenders = Object.entries(scan.senderStatuses)
                    .filter(([, sender]) => sender.status === 'inactive')
                    .map(([folder]) => folder);
                if (unavailableSenders.length) {
                    lines.push(`Unavailable: ${unavailableSenders.slice(0, 5).join(', ')}`);
                }
            }
        }
        lines.push(`Sender operation: ${sender?.status || 'idle'}`);
        if (sender?.sessionFolder) lines.push(`Session: ${sender.sessionFolder}`);
        if (pairingCode) lines.push('Enter the code shown on the button in WhatsApp to link the sender.');
        if (sender?.error) lines.push(`Sender error: ${sender.error}`);
        if (scan?.error) lines.push(`Scan error: ${scan.error}`);
        const keyboard = buildStatusKeyboard({
            pairingCode,
            callbackData: registerAction
        });
        return { text: lines.join('\n'), keyboard };
    };

    const scheduleScanProgressRefresh = (chatId, messageId, token, lastText) => {
        const key = String(chatId);
        const refresh = { token, lastText, timer: null };
        refresh.timer = setTimeout(async () => {
            if (scanProgressRefreshes.get(key)?.token !== token) return;
            try {
                const { scan } = service.getStatus();
                if (scanProgressRefreshes.get(key)?.token !== token) return;
                if (!scan) {
                    scanProgressRefreshes.delete(key);
                    return;
                }
                const text = formatScanProgress(scan);
                if (text !== refresh.lastText) {
                    const results = scan.status === 'completed'
                        ? service.getResults().results.filter(isResultFilename)
                        : [];
                    const message = await dashboard.present(
                        chatId,
                        messageId,
                        text,
                        buildScanProgressKeyboard(registerAction, results)
                    );
                    refresh.lastText = text;
                    messageId = message.message_id;
                }
                scanProgressErrors.delete(key);
                if (['starting', 'running'].includes(scan.status)) {
                    scheduleScanProgressRefresh(chatId, messageId, token, refresh.lastText);
                } else {
                    scanProgressRefreshes.delete(key);
                }
            } catch (error) {
                if (scanProgressRefreshes.get(key)?.token !== token) return;
                if (!scanProgressErrors.has(key)) {
                    scanProgressErrors.add(key);
                    console.error('Telegram scan progress refresh failed:', error.message);
                }
                scheduleScanProgressRefresh(chatId, messageId, token, refresh.lastText);
            }
        }, 2000);
        refresh.timer.unref?.();
        scanProgressRefreshes.set(key, refresh);
    };

    const showScanProgress = async (ctx, scan, resultPage = 0) => {
        clearScanProgressRefresh(ctx.chat.id);
        const text = formatScanProgress(scan);
        const results = scan?.status === 'completed'
            ? service.getResults().results.filter(isResultFilename)
            : [];
        const result = await present(
            ctx,
            text,
            buildScanProgressKeyboard(registerAction, results, resultPage)
        );
        const messageId = dashboard.getMessageId(ctx.chat.id) || result?.message_id;
        if (messageId && ['starting', 'running'].includes(scan?.status)) {
            scheduleScanProgressRefresh(
                ctx.chat.id,
                messageId,
                crypto.randomBytes(6).toString('hex'),
                text
            );
        }
        return result;
    };

    const refreshScanProgress = async (ctx, resultPage = 0) => {
        const { scan } = service.getStatus();
        if (!scan) {
            clearScanProgressRefresh(ctx.chat.id);
            await showMainMenu(ctx, 'No scan is currently available.');
            return;
        }
        await showScanProgress(ctx, scan, resultPage);
    };

    const schedulePairingRefresh = (chatId, messageId, expiresAt, preserveErrors = false) => {
        clearPairingRefresh(chatId, !preserveErrors);
        const refresh = { active: true, timer: null };
        refresh.timer = setTimeout(async () => {
            if (!refresh.active || pairingRefreshTimers.get(chatId) !== refresh) return;
            try {
                const { scan, sender } = service.getStatus();
                if (!refresh.active || pairingRefreshTimers.get(chatId) !== refresh) return;
                const timedOut = Date.now() >= expiresAt;
                const presentation = createStatusPresentation(
                    scan,
                    sender,
                    timedOut ? 'Automatic status updates paused.' : null,
                    !timedOut
                );
                const message = await dashboard.present(
                    chatId,
                    messageId,
                    presentation.text,
                    presentation.keyboard
                );
                messageId = message.message_id;
                pairingRefreshErrors.delete(chatId);
                if (shouldContinuePairingRefresh(sender, expiresAt)) {
                    schedulePairingRefresh(chatId, messageId, expiresAt, true);
                } else {
                    pairingRefreshTimers.delete(chatId);
                    pairingRefreshErrors.delete(chatId);
                }
            } catch (error) {
                if (!refresh.active || pairingRefreshTimers.get(chatId) !== refresh) return;
                if (!pairingRefreshErrors.has(chatId)) {
                    console.error('Telegram pairing status refresh failed:', error.message);
                    pairingRefreshErrors.add(chatId);
                }
                if (Date.now() < expiresAt) {
                    schedulePairingRefresh(chatId, messageId, expiresAt, true);
                    return;
                }
                pairingRefreshTimers.delete(chatId);
                pairingRefreshErrors.delete(chatId);
            }
        }, PAIRING_REFRESH_INTERVAL_MS);
        refresh.timer.unref?.();
        pairingRefreshTimers.set(chatId, refresh);
    };

    const showStatus = async (ctx, message) => {
        clearSenderViewRefresh(ctx.chat?.id);
        const { scan, sender } = service.getStatus();
        const presentation = createStatusPresentation(scan, sender, message);
        const result = await present(ctx, presentation.text, presentation.keyboard);
        const messageId = dashboard.getMessageId(ctx.chat.id) || result?.message_id;
        if (!isPairingInProgress(sender)) {
            clearPairingRefresh(ctx.chat.id);
        } else if (messageId) {
            schedulePairingRefresh(
                ctx.chat.id,
                messageId,
                Date.now() + PAIRING_REFRESH_MAX_DURATION_MS
            );
        }
        return result;
    };

    const showCollection = async (ctx, kind, requestedPage = 0, message) => {
        clearSenderViewRefresh(ctx.chat?.id);
        const config = {
            senders: { list: service.getSenders, key: 'senders', heading: '👤 Sender sessions' },
            targets: {
                list: () => ({ targets: service.getTargetNames() }),
                key: 'targets',
                heading: 'Targets'
            },
            results: { list: service.getResults, key: 'results', heading: '📦 Scan results' }
        }[kind];
        if (!config) throw new Error('This list is not available.');
        const [response, senderHealth] = await Promise.all([
            config.list(),
            kind === 'senders' ? service.getSenderHealth({ probe: false }) : Promise.resolve(null)
        ]);
        const allItems = response[config.key];
        const items = kind === 'results' ? allItems.filter(isResultFilename) : allItems;
        const activeTarget = kind === 'targets'
            ? activeTargetSelection.reconcile(response.targets)
            : null;
        const { page, pageCount, items: visibleItems } = paginateItems(items, requestedPage);
        const keyboard = new InlineKeyboard();

        if (kind === 'senders') {
            const statuses = new Map(senderHealth.senders.map(item => [item.folder, item]));
            const result = await present(
                ctx,
                formatSenderSessionsText(page, pageCount, items.length),
                buildSenderSessionsKeyboard({
                    senders: visibleItems,
                    statuses,
                    page,
                    pageCount,
                    callbackData: registerAction
                })
            );
            if (senderHealth.checking) {
                const messageId = dashboard.getMessageId(ctx.chat.id) || result?.message_id;
                if (messageId) scheduleSenderViewRefresh(ctx.chat.id, messageId, page);
            }
            return result;
        } else if (kind === 'results') {
            const text = items.length
                ? `${config.heading} · page ${page + 1} of ${pageCount}${message ? `\n\n${message}` : ''}`
                : `${config.heading}\n\n${message ? `${message}\n\n` : ''}No results with findings are available yet.`;
            return present(
                ctx,
                text,
                buildResultsKeyboard({
                    results: visibleItems,
                    page,
                    pageCount,
                    callbackData: registerAction
                })
            );
        } else if (kind === 'targets') {
            actionButton(keyboard, '⬆️ Upload Targets', { type: 'upload-targets', page }).row();
        }
        visibleItems.forEach(item => {
            if (kind === 'targets') {
                actionButton(keyboard, item, { type: 'target-details', filename: item, page });
            }
            keyboard.row();
            if (kind === 'targets') {
                actionButton(keyboard, 'Remove', {
                    type: 'confirm',
                    action: { type: 'delete-target', filename: item },
                    returnTo: { type: 'show-targets', page }
                }).row();
            }
        });

        if (pageCount > 1) {
            if (page > 0) actionButton(keyboard, '⬅️ Previous', { type: `show-${kind}`, page: page - 1 });
            if (page + 1 < pageCount) actionButton(keyboard, 'Next ➡️', { type: `show-${kind}`, page: page + 1 });
            keyboard.row();
        }
        addMenuButton(keyboard).row();

        const emptyMessage = 'Send a .txt or .xlsx document to this chat using Upload Targets.';
        const text = kind === 'targets'
            ? `${config.heading}\n\n${message ? `${message}\n` : ''}${items.length ? 'Choose a target to manage it. Select the active target from the main menu.' : emptyMessage}${pageCount > 1 ? `\nPage ${page + 1} of ${pageCount}` : ''}`
            : `${config.heading}\n\n${emptyMessage}`;
        const result = await present(ctx, text, keyboard);
        return result;
    };

    const scheduleSenderViewRefresh = (chatId, messageId, page, token = crypto.randomBytes(6).toString('hex')) => {
        clearTimeout(senderViewRefreshes.get(chatId)?.timer);
        senderViewTokens.set(chatId, token);
        const errorKey = String(chatId);
        const refresh = { timer: null };
        refresh.timer = setTimeout(async () => {
            if (senderViewTokens.get(chatId) !== token) return;
            try {
                const [response, health] = await Promise.all([
                    Promise.resolve(service.getSenders()),
                    service.getSenderHealth({ probe: false, wait: true })
                ]);
                if (senderViewTokens.get(chatId) !== token) return;

                const { page: currentPage, pageCount, items } = paginateItems(response.senders, page);
                const statuses = new Map(health.senders.map(item => [item.folder, item]));
                const keyboard = buildSenderSessionsKeyboard({
                    senders: items,
                    statuses,
                    page: currentPage,
                    pageCount,
                    callbackData: registerAction
                });
                await dashboard.present(
                    chatId,
                    messageId,
                    formatSenderSessionsText(currentPage, pageCount, response.senders.length),
                    keyboard
                );
                senderViewRefreshes.delete(chatId);
                senderViewTokens.delete(chatId);
                senderHealthErrors.delete(errorKey);
            } catch (error) {
                if (senderViewTokens.get(chatId) !== token) return;
                if (!senderHealthErrors.has(errorKey)) {
                    senderHealthErrors.add(errorKey);
                    console.error('Telegram sender status refresh failed:', error.message);
                }
                senderViewRefreshes.delete(chatId);
                senderViewTokens.delete(chatId);
            }
        }, 750);
        refresh.timer.unref?.();
        senderViewRefreshes.set(chatId, refresh);
    };

    const showTargetDetails = async (ctx, item, page) => {
        const keyboard = new InlineKeyboard();
        const text = `Target list\n${item}`;
        actionButton(keyboard, 'Remove target', {
            type: 'confirm',
            action: { type: 'delete-target', filename: item },
            returnTo: { type: 'show-targets', page }
        }).row();
        actionButton(keyboard, '⬅️ Back to list', { type: 'show-targets', page });
        addMenuButton(keyboard).row();
        return present(ctx, text, keyboard);
    };

    const beginScanForActiveTarget = async ctx => {
        const [{ targets, checkpoints }, { senders }] = await Promise.all([
            Promise.resolve(service.getTargets()),
            Promise.resolve(service.getSenders())
        ]);
        const target = activeTargetSelection.reconcile(targets);
        if (!target) {
            await showMainMenu(ctx, 'Select a target from the main menu before starting a scan.');
            return;
        }
        if (!senders.length) {
            await showMainMenu(ctx, 'No sender sessions are available. Add a sender first.');
            return;
        }
        await showScanBatchOptions(ctx, {
            target,
            checkpoint: checkpoints[target],
            hasCheckpoint: Boolean(checkpoints[target])
        });
    };

    const showScanBatchOptions = async (ctx, selection) => {
        const keyboard = new InlineKeyboard();
        for (const size of [25, 50, 100]) {
            actionButton(keyboard, String(size), {
                type: 'scan-size',
                target: selection.target,
                checkpoint: selection.checkpoint,
                hasCheckpoint: selection.hasCheckpoint,
                targetPage: selection.targetPage,
                batchSize: size
            });
        }
        actionButton(keyboard, 'Custom size', {
            type: 'scan-custom-size',
            selection
        }).row();
        addMenuButton(keyboard).row();
        return present(ctx, `Choose the number of targets per batch for ${selection.target}:`, keyboard);
    };

    const startSenderPairing = async (ctx, phoneNumber) => {
        service.startSender({ phoneNumber });
        pendingSenderNumbers.delete(String(ctx.from.id));
        await showStatus(ctx, 'Pairing request started. This status will refresh automatically while pairing is in progress.');
    };

    const promptSenderPhone = async ctx => {
        pendingBatchSizes.delete(String(ctx.from.id));
        pendingSenderNumbers.set(String(ctx.from.id), Date.now() + ACTION_TTL_MS);
        const keyboard = new InlineKeyboard();
        actionButton(keyboard, 'Cancel', { type: 'main-menu' });
        return present(ctx, 'Send the sender phone number including country code, or cancel to return to the menu.', keyboard);
    };

    const sendResults = async (ctx, filename) => {
        if (!isResultFilename(filename)) throw new Error('Only generated result text files can be sent.');
        const { results } = service.getResults();
        if (!results.includes(filename)) throw new Error('Result not found.');
        await ctx.replyWithDocument(
            new InputFile(service.getResultPath(filename), filename),
            { caption: filename }
        );
    };

    const startScan = async (ctx, selection, resume) => {
        const { senders } = service.getSenders();
        if (!senders.length) throw new Error('No sender sessions are available. Add a sender first.');
        service.startScan({
            targetFile: selection.target,
            sessionFolders: senders,
            batchSize: selection.batchSize,
            resume
        });
        const { scan } = service.getStatus();
        await showScanProgress(ctx, scan || {
            status: 'starting',
            targetFile: selection.target,
            sessionFolders: senders
        });
    };

    const requestCheckpointChoice = async (ctx, selection) => {
        const keyboard = new InlineKeyboard();
        if (!selection.hasCheckpoint) {
            actionButton(keyboard, '▶️ Start scan', {
                type: 'scan-start',
                selection,
                resume: false
            });
            actionButton(keyboard, '⬅️ Back', {
                type: 'show-scan-batches',
                selection
            }).row();
            actionButton(keyboard, 'Cancel', { type: 'main-menu' });
            return present(
                ctx,
                `Ready to scan ${selection.target} with all active senders (${selection.batchSize} targets per batch).`,
                keyboard
            );
        }
        if (!selection.checkpoint?.invalid) {
            actionButton(keyboard, '▶️ Resume checkpoint', { type: 'scan-start', selection, resume: true });
        }
        actionButton(keyboard, 'Start over', {
            type: 'scan-start',
            selection,
            resume: false
        });
        actionButton(keyboard, '⬅️ Back', {
            type: 'show-scan-batches',
            selection
        }).row();
        actionButton(keyboard, 'Cancel', { type: 'main-menu' });
        return present(
            ctx,
            selection.checkpoint?.invalid
                ? 'The checkpoint is invalid. Start a new scan from the beginning?'
                : `A checkpoint exists with ${selection.checkpoint.completedBatchIndices?.length
                    ?? selection.checkpoint.batchIndex} of ${selection.checkpoint.totalBatches} batches completed. Resume or start over?`,
            keyboard
        );
    };

    const askConfirmation = async (ctx, message, action, returnTo) => {
        const keyboard = buildConfirmationKeyboard(registerAction, action, returnTo);
        return present(ctx, message, keyboard);
    };

    const shutdownLocalApplication = async ctx => {
        await editShutdownNotice((text, options) => present(ctx, text, options.reply_markup));
        await new Promise(resolve => setTimeout(resolve, 500));
        await service.requestShutdown({ confirm: true });
    };

    const performAction = async (ctx, action) => {
        switch (action.type) {
            case 'delete-sender':
                await service.deleteSender(action.folder, { confirm: true });
                if (!action.suppressMenu) await showMainMenu(ctx, `Sender ${action.folder} was removed.`);
                return;
            case 'delete-target':
                service.deleteTarget(action.filename, { confirm: true });
                if (activeTargetSelection.get() === action.filename) activeTargetSelection.clear();
                if (!action.suppressMenu) await showMainMenu(ctx, `Target list ${action.filename} and its checkpoint were removed.`);
                return;
            case 'delete-result':
                {
                    const result = service.deleteResult(action.filename, { confirm: true });
                    if (!action.suppressMenu) {
                        const checkpointMessage = result.checkpointDeleted
                            ? ' Its checkpoint was also removed.'
                            : '';
                        await showMainMenu(ctx, `Result ${action.filename} was removed.${checkpointMessage}`);
                    }
                    return result;
                }
            case 'send-result':
                await sendResults(ctx, action.filename);
                await showCollection(ctx, 'results', action.page, `${action.filename} was sent.`);
                return;
            case 'scan-result-page':
                await refreshScanProgress(ctx, action.page);
                return;
            case 'show-status':
                await showStatus(ctx);
                return;
            case 'scan-progress-refresh':
                await refreshScanProgress(ctx);
                return;
            case 'request-result-removal-confirmation':
                if (action.action?.type !== 'delete-result') {
                    throw new Error('This confirmation request is not available.');
                }
                await askConfirmation(
                    ctx,
                    `Remove ${formatResultButtonLabel(action.action.filename)}? The related checkpoint will also be removed, if present.`,
                    action.action,
                    action.returnTo
                );
                return;
            case 'main-menu':
                pendingBatchSizes.delete(String(ctx.from.id));
                pendingSenderNumbers.delete(String(ctx.from.id));
                await showMainMenu(ctx);
                return;
            case 'show-senders':
                if (shouldProbeSenderHealth({ action })) {
                    scheduleSenderHealthCheck(ctx.chat.id);
                }
                await showCollection(ctx, 'senders', action.page);
                return;
            case 'refresh-senders':
                await showCollection(ctx, 'senders', action.page);
                return;
            case 'show-targets':
                await showCollection(ctx, 'targets', action.page);
                return;
            case 'show-results':
                await showCollection(ctx, 'results', action.page, action.message);
                return;
            case 'show-scan':
                await beginScanForActiveTarget(ctx);
                return;
            case 'main-menu-page':
                await showMainMenu(ctx, 'What would you like to do?', action.page);
                return;
            case 'upload-targets': {
                const keyboard = new InlineKeyboard();
                if (action.returnToMain) {
                    actionButton(keyboard, '🏠 Main menu', {
                        type: 'main-menu-page',
                        page: action.page || 0
                    }).row();
                } else {
                    actionButton(keyboard, '⬅️ Back', {
                        type: 'show-targets',
                        page: action.page || 0
                    }).row();
                    actionButton(keyboard, 'Cancel', { type: 'main-menu' }).row();
                }
                await present(
                    ctx,
                    'Upload Targets\n\nSend a .txt or .xlsx document to this chat to add a target list.',
                    keyboard
                );
                return;
            }
            case 'select-target': {
                const targets = service.getTargetNames();
                const activeTarget = activeTargetSelection.select(action.filename, targets);
                if (action.returnToMain) {
                    const { scan } = service.getStatus();
                    const { page } = paginateItems(targets, action.page);
                    await dashboard.updateReplyMarkup(
                        ctx.chat.id,
                        ctx.callbackQuery?.message?.message_id,
                        mainMenuKeyboard(targets, activeTarget, page, scan?.status)
                    );
                } else {
                    await showCollection(
                        ctx,
                        'targets',
                        action.page,
                        `Active target set to ${getTargetDisplayName(action.filename)}.`
                    );
                }
                return;
            }
            case 'target-details':
                await showTargetDetails(ctx, action.filename, action.page);
                return;
            case 'show-scan-batches':
                pendingBatchSizes.delete(String(ctx.from.id));
                await showScanBatchOptions(ctx, action.selection);
                return;
            case 'scan-custom-size':
                pendingBatchSizes.set(String(ctx.from.id), {
                    ...action.selection,
                    expiresAt: Date.now() + ACTION_TTL_MS
                });
                {
                    const keyboard = new InlineKeyboard();
                    actionButton(keyboard, '⬅️ Back', {
                        type: 'show-scan-batches',
                        selection: action.selection
                    });
                    actionButton(keyboard, 'Cancel', { type: 'cancel' }).row();
                    await present(ctx, 'Send a positive whole number for the batch size.', keyboard);
                }
                return;
            case 'scan-size':
                pendingBatchSizes.delete(String(ctx.from.id));
                await requestCheckpointChoice(ctx, {
                    target: action.target,
                    checkpoint: action.checkpoint,
                    hasCheckpoint: action.hasCheckpoint,
                    targetPage: action.targetPage,
                    senderPage: action.senderPage,
                    batchSize: action.batchSize
                });
                return;
            case 'scan-start':
                pendingBatchSizes.delete(String(ctx.from.id));
                await startScan(ctx, action.selection, action.resume);
                return;
            case 'confirm':
                if (action.action.type === 'shutdown') {
                    await shutdownLocalApplication(ctx);
                    return;
                }
                {
                    const result = await performAction(ctx, { ...action.action, suppressMenu: true });
                    if (action.returnTo) {
                        const returnTo = { ...action.returnTo };
                        if (action.action.type === 'delete-result') {
                            returnTo.message = result.checkpointDeleted
                                ? `Result ${action.action.filename} and its checkpoint were removed.`
                                : `Result ${action.action.filename} was removed.`;
                        }
                        await performAction(ctx, returnTo);
                    }
                }
                return;
            case 'cancel':
                pendingBatchSizes.delete(String(ctx.from.id));
                pendingSenderNumbers.delete(String(ctx.from.id));
                if (action.returnTo) await performAction(ctx, action.returnTo);
                else await showMainMenu(ctx, 'Action cancelled.');
                return;
            case 'add-sender':
                await promptSenderPhone(ctx);
                return;
            case 'shutdown':
                await askConfirmation(
                    ctx,
                    'Shut down the local cekbio application? This does not shut down Windows.',
                    { type: 'shutdown' }
                );
                return;
            default:
                throw new Error('This action is not available.');
        }
    };

    bot.use(async (ctx, next) => {
        if (!isAuthorizedUpdate(ctx, ownerId)) {
            try {
                await acknowledgeCallbackQuery(ctx);
            } catch (error) {
                console.error('Telegram callback acknowledgement failed:', error.message);
            }
            return;
        }
        if (ctx.callbackQuery) {
            acknowledgeCallbackQueryWithoutWaiting(ctx);
            clearScanProgressRefresh(ctx.chat?.id);
        }
        await next();
    });

    bot.callbackQuery(/^a:/, async ctx => {
        const action = actions.consume(ctx.callbackQuery.data);
        if (!action) {
            await showMainMenu(ctx, 'That button expired. Please choose an option again.');
            return;
        }
        if (action.type !== 'show-status') clearPairingRefresh(ctx.chat.id);
        if (!['show-senders', 'refresh-senders'].includes(action.type)) clearSenderViewRefresh(ctx.chat.id);
        try {
            await performAction(ctx, action);
        } catch (error) {
            await showMainMenu(ctx, error.message || 'The operation could not be completed.');
        }
    });
    bot.command('start', async ctx => {
        pendingBatchSizes.delete(String(ctx.from.id));
        pendingSenderNumbers.delete(String(ctx.from.id));
        if (shouldProbeSenderHealth({ command: 'start' })) {
            scheduleSenderHealthCheck(ctx.chat?.id);
        }
        await showMainMenu(ctx, 'Choose an action below.');
    });

    bot.command('shutdown', async ctx => {
        await askConfirmation(ctx, 'Shut down the local cekbio application? This does not shut down Windows.', {
            type: 'shutdown'
        });
    });

    bot.on('message:text', async (ctx, next) => {
        if (ctx.message.text.startsWith('/')) return next();
        const ownerKey = String(ctx.from.id);
        const senderExpiresAt = pendingSenderNumbers.get(ownerKey);
        if (senderExpiresAt) {
            if (senderExpiresAt <= Date.now()) {
                pendingSenderNumbers.delete(ownerKey);
                await showMainMenu(ctx, 'Add-sender request expired. Choose Add sender to try again.');
                return;
            }
            const phoneNumber = ctx.message.text.trim();
            if (phoneNumber.replace(/\D/g, '').length < 6) {
                const keyboard = new InlineKeyboard();
                actionButton(keyboard, 'Cancel', { type: 'main-menu' });
                await present(
                    ctx,
                    'That number looks too short. Enter the sender number with country code, or cancel.',
                    keyboard
                );
                return;
            }
            await startSenderPairing(ctx, phoneNumber);
            return;
        }
        const pending = pendingBatchSizes.get(ownerKey);
        if (!pending) return next();
        if (pending.expiresAt <= Date.now()) {
            pendingBatchSizes.delete(ownerKey);
            await showMainMenu(ctx, 'Batch-size request expired. Choose Scan to try again.');
            return;
        }
        const batchText = ctx.message.text.trim();
        const batchSize = Number(batchText);
        if (!/^\d+$/.test(batchText) || !Number.isSafeInteger(batchSize) || batchSize < 1) {
            const keyboard = new InlineKeyboard();
            actionButton(keyboard, '⬅️ Back', {
                type: 'show-scan-batches',
                selection: pending
            });
            actionButton(keyboard, 'Cancel', { type: 'main-menu' });
            await present(ctx, 'Enter a positive whole number for the batch size, or cancel.', keyboard);
            return;
        }
        pendingBatchSizes.delete(ownerKey);
        await requestCheckpointChoice(ctx, { ...pending, batchSize });
    });

    bot.on('message:document', async ctx => {
        const document = ctx.message.document;
        const filename = document.file_name || '';
        const extension = path.extname(filename).toLowerCase();
        if (!['.txt', '.xlsx'].includes(extension)) {
            await showMainMenu(ctx, 'Only .txt and .xlsx target files are supported.');
            return;
        }
        if (document.file_size > MAX_UPLOAD_BYTES) {
            await showMainMenu(ctx, 'The target file must be no larger than 10 MB.');
            return;
        }
        try {
            const file = await ctx.getFile();
            if (!file.file_path || file.file_path.split('/').includes('..')
                || !/^[A-Za-z0-9_./-]+$/.test(file.file_path)) {
                throw new Error('Telegram did not provide a valid file path.');
            }
            const response = await fetch(`https://api.telegram.org/file/bot${token}/${encodeURI(file.file_path)}`);
            if (!response.ok) throw new Error('Telegram could not provide the uploaded file.');
            const contents = Buffer.from(await response.arrayBuffer());
            if (contents.length === 0 || contents.length > MAX_UPLOAD_BYTES) {
                throw new Error('The target file must contain data and be no larger than 10 MB.');
            }
            if (extension === '.txt') {
                const text = new TextDecoder('utf-8', { fatal: true }).decode(contents);
                const result = service.uploadTargetText({ name: filename, contents: text });
                await showMainMenu(ctx, `Target list ${result.target} was uploaded. Choose it below to make it active.`);
            } else {
                const result = service.uploadTargetWorkbook({ name: filename, contents });
                await showMainMenu(ctx, `${result.message} Choose the target below to make it active.`);
            }
        } catch (error) {
            await showMainMenu(ctx, error.message || 'The target file could not be uploaded.');
        }
    });

    bot.catch(async error => {
        try {
            const keyboard = new InlineKeyboard();
            addMenuButton(keyboard);
            await present(
                error.ctx,
                'The bot could not complete that request. Check the local application and try again.',
                keyboard
            );
        } catch {
            console.error('Telegram update failed while updating the dashboard; check bot connectivity and the local application.');
        }
    });

    await bot.init();
    await bot.api.setMyCommands(TELEGRAM_COMMANDS);

    const polling = bot.start({
        onStart: info => console.log(`Telegram bot @${info.username} is connected in private-owner mode.`)
    });
    polling.catch(() => onError());

    return {
        bot,
        stop: () => {
            for (const refresh of pairingRefreshTimers.values()) {
                refresh.active = false;
                clearTimeout(refresh.timer);
            }
            pairingRefreshTimers.clear();
            pairingRefreshErrors.clear();
            for (const refresh of senderViewRefreshes.values()) clearTimeout(refresh.timer);
            senderViewRefreshes.clear();
            senderViewTokens.clear();
            for (const refresh of scanProgressRefreshes.values()) clearTimeout(refresh.timer);
            scanProgressRefreshes.clear();
            scanProgressErrors.clear();
            dashboard.clear();
            return bot.stop();
        },
        polling
    };
};

module.exports = {
    addPairingCodeCopyButton,
    buildStatusKeyboard,
    buildScanProgressKeyboard,
    buildMainMenuKeyboard,
    buildResultsKeyboard,
    buildConfirmationKeyboard,
    buildSenderSessionsKeyboard,
    createActionRegistry,
    createActiveTargetSelection,
    createDashboardPresenter,
    formatSenderButtonLabel,
    getActionButtonStyle,
    getSenderButtonStyle,
    getTargetButtonStyle,
    formatSenderSessionsText,
    formatScanProgress,
    formatResultButtonLabel,
    formatTargetButtonLabel,
    formatMainMenuText,
    getTargetDisplayName,
    getVisiblePairingCode,
    isAuthorizedUpdate,
    acknowledgeCallbackQuery,
    acknowledgeCallbackQueryWithoutWaiting,
    shouldProbeSenderHealth,
    isPairingInProgress,
    shouldContinuePairingRefresh,
    isResultFilename,
    paginateItems,
    editShutdownNotice,
    startTelegramBot,
    TELEGRAM_COMMANDS,
    BUTTON_STYLE,
    validateTelegramConfig
};
