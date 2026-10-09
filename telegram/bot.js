const crypto = require('crypto');
const path = require('path');
const { Bot, InlineKeyboard, InputFile } = require('grammy');

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const RESULT_PATTERN = /^result_(business|personal|unregistered)_(.+)\.txt$/;
const ACTION_TTL_MS = 10 * 60 * 1000;
const LIST_PAGE_SIZE = 6;
const PAIRING_REFRESH_INTERVAL_MS = 500;
const PAIRING_REFRESH_MAX_DURATION_MS = 185000;

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

const formatTargetButtonLabel = (filename, isActive) =>
    `${isActive ? '✅' : '◯'} ${getTargetDisplayName(filename)}`;

const formatSenderButtonLabel = (folder, status) => {
    const indicator = ['alive', 'active', 'scanning'].includes(status)
        ? '🟢'
        : status === 'checking'
            ? '🟡'
            : '⚪';
    return `${indicator} ${folder}`;
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
    keyboard.copyText('📋 Copy code', pairingCode).row();
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

const buildMainMenuKeyboard = ({ targets, activeTarget, page, callbackData }) => {
    const keyboard = new InlineKeyboard();
    const { page: currentPage, pageCount, items } = paginateItems(targets, page);
    const addButton = (label, payload) =>
        keyboard.text([...String(label)].slice(0, 60).join(''), callbackData(payload));

    addButton('📊 Status', { type: 'show-status' });
    addButton('👤 Senders', { type: 'show-senders', page: 0 }).row();
    addButton('🔎 Scan', { type: 'show-scan', page: 0 });
    addButton('📦 Results', { type: 'show-results', page: 0 }).row();
    addButton('⬆️ Upload Targets', { type: 'upload-targets', page: currentPage }).row();

    for (const target of items) {
        addButton(
            formatTargetButtonLabel(target, target === activeTarget),
            { type: 'select-target', filename: target, page: currentPage, returnToMain: true }
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
    return keyboard;
};

const formatMainMenuText = (message, activeTarget, page, pageCount, targetCount) => {
    const targetStatus = activeTarget
        ? `Active target: ${getTargetDisplayName(activeTarget)}`
        : 'No active target selected.';
    const targetGuidance = targetCount
        ? 'Select one target below, or upload a new list.'
        : 'Upload a .txt or .xlsx document to add a target list.';
    return [
        'cekbio',
        '',
        message,
        '',
        'Targets',
        targetStatus,
        targetGuidance,
        ...(pageCount > 1 ? [`Page ${page + 1} of ${pageCount}`] : [])
    ].join('\n');
};

const isAuthorizedUpdate = (ctx, ownerId) => Boolean(ctx.from
    && ctx.chat?.type === 'private'
    && ctx.chat.id === ctx.from.id
    && String(ctx.from.id) === String(ownerId));

const createApiClient = baseUrl => async (pathname, options = {}) => {
    let response;
    try {
        response = await fetch(new URL(pathname, baseUrl), {
            ...options,
            headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers }
        });
    } catch {
        throw new Error('Could not reach the local cekbio service. Check that it is still running.');
    }
    const result = response.headers.get('content-type')?.includes('application/json')
        ? await response.json()
        : null;
    if (!response.ok) throw new Error(result?.error || `Local request failed (${response.status}).`);
    return result;
};

const jsonPost = body => ({ method: 'POST', body: JSON.stringify(body) });

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

const startTelegramBot = async ({ token, ownerId, baseUrl, onError = () => {} }) => {
    validateTelegramConfig({ token, ownerId });
    ownerId = String(Number(ownerId));

    const bot = new Bot(token);
    const api = createApiClient(baseUrl);
    const actions = createActionRegistry();
    const activeTargetSelection = createActiveTargetSelection();
    const pendingBatchSizes = new Map();
    const pendingSenderNumbers = new Map();
    const pairingRefreshTimers = new Map();
    const pairingRefreshErrors = new Set();
    const senderViewRefreshes = new Map();
    const senderViewTokens = new Map();
    const senderHealthErrors = new Set();

    const registerAction = (payload) => {
        return actions.create(payload);
    };

    const actionButton = (keyboard, label, payload) => {
        keyboard.text([...String(label)].slice(0, 60).join(''), registerAction(payload));
        return keyboard;
    };

    const clearSenderViewRefresh = chatId => {
        const refresh = senderViewRefreshes.get(chatId);
        if (refresh) clearTimeout(refresh.timer);
        senderViewRefreshes.delete(chatId);
        senderViewTokens.delete(chatId);
    };

    const createSenderListKeyboard = (senders, statuses, page) => {
        const keyboard = new InlineKeyboard();
        actionButton(keyboard, '➕ Add sender', { type: 'add-sender' }).row();
        for (const folder of senders) {
            const status = statuses.get(folder)?.status;
            actionButton(keyboard, formatSenderButtonLabel(folder, status), {
                type: 'refresh-senders',
                page
            }).row();
            actionButton(keyboard, 'Remove', {
                type: 'confirm',
                action: { type: 'delete-sender', folder },
                returnTo: { type: 'show-senders', page }
            }).row();
        }
        return keyboard;
    };

    const present = (ctx, text, replyMarkup) => {
        const options = { reply_markup: replyMarkup };
        return ctx.callbackQuery ? ctx.editMessageText(text, options) : ctx.reply(text, options);
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

    const mainMenuKeyboard = (targets, activeTarget, page) => {
        return buildMainMenuKeyboard({
            targets,
            activeTarget,
            page,
            callbackData: registerAction
        });
    };

    const addMenuButton = (keyboard, label = '🏠 Main menu') => {
        actionButton(keyboard, label, { type: 'main-menu' });
        return keyboard;
    };

    const showMainMenu = async (ctx, message = 'What would you like to do?', page = 0) => {
        clearSenderViewRefresh(ctx.chat?.id);
        if (ctx.chat?.id) clearPairingRefresh(ctx.chat.id);
        const { targets } = await api('/api/targets');
        const activeTarget = activeTargetSelection.reconcile(targets);
        const { page: currentPage, pageCount } = paginateItems(targets, page);
        const text = formatMainMenuText(message, activeTarget, currentPage, pageCount, targets.length);
        return present(ctx, text, mainMenuKeyboard(targets, activeTarget, currentPage));
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
        if (pairingCode) {
            lines.push(`Pairing code: ${pairingCode}`);
            lines.push('Enter this code in WhatsApp to link the sender.');
        }
        if (sender?.error) lines.push(`Sender error: ${sender.error}`);
        if (scan?.error) lines.push(`Scan error: ${scan.error}`);
        const keyboard = new InlineKeyboard();
        if (pairingCode) addPairingCodeCopyButton(keyboard, pairingCode);
        actionButton(keyboard, '↻ Refresh', { type: 'show-status' });
        addMenuButton(keyboard).row();
        return { text: lines.join('\n'), keyboard };
    };

    const schedulePairingRefresh = (chatId, messageId, expiresAt, preserveErrors = false) => {
        clearPairingRefresh(chatId, !preserveErrors);
        const refresh = { active: true, timer: null };
        refresh.timer = setTimeout(async () => {
            if (!refresh.active || pairingRefreshTimers.get(chatId) !== refresh) return;
            try {
                const { scan, sender } = await api('/api/status');
                if (!refresh.active || pairingRefreshTimers.get(chatId) !== refresh) return;
                const timedOut = Date.now() >= expiresAt;
                const presentation = createStatusPresentation(
                    scan,
                    sender,
                    timedOut ? 'Automatic refresh paused. Use Refresh to check again.' : null,
                    !timedOut
                );
                await bot.api.editMessageText(chatId, messageId, presentation.text, {
                    reply_markup: presentation.keyboard
                });
                pairingRefreshErrors.delete(chatId);
                if (shouldContinuePairingRefresh(sender, expiresAt)) {
                    schedulePairingRefresh(chatId, messageId, expiresAt, true);
                } else {
                    pairingRefreshTimers.delete(chatId);
                    pairingRefreshErrors.delete(chatId);
                }
            } catch {
                if (!refresh.active || pairingRefreshTimers.get(chatId) !== refresh) return;
                if (Date.now() < expiresAt) {
                    if (!pairingRefreshErrors.has(chatId)) {
                        console.error('Telegram pairing status refresh failed; retrying while pairing remains active.');
                        pairingRefreshErrors.add(chatId);
                    }
                    schedulePairingRefresh(chatId, messageId, expiresAt, true);
                    return;
                }
                pairingRefreshTimers.delete(chatId);
                pairingRefreshErrors.delete(chatId);
                console.error('Telegram pairing status refresh stopped after repeated update failures.');
            }
        }, PAIRING_REFRESH_INTERVAL_MS);
        refresh.timer.unref?.();
        pairingRefreshTimers.set(chatId, refresh);
    };

    const showStatus = async (ctx, message) => {
        clearSenderViewRefresh(ctx.chat?.id);
        const { scan, sender } = await api('/api/status');
        const presentation = createStatusPresentation(scan, sender, message);
        const result = await present(ctx, presentation.text, presentation.keyboard);
        const messageId = ctx.callbackQuery?.message?.message_id || result?.message_id;
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
            senders: { endpoint: '/api/senders', key: 'senders', heading: '👤 Sender sessions' },
            targets: { endpoint: '/api/targets', key: 'targets', heading: 'Targets' },
            results: { endpoint: '/api/results', key: 'results', heading: '📦 Scan results' }
        }[kind];
        if (!config) throw new Error('This list is not available.');
        const [response, senderHealth] = await Promise.all([
            api(config.endpoint),
            kind === 'senders' ? api('/api/senders/health?refresh=0') : Promise.resolve(null)
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
            keyboard.inline_keyboard.push(...createSenderListKeyboard(visibleItems, statuses, page).inline_keyboard);
        } else if (kind === 'targets') {
            actionButton(keyboard, '⬆️ Upload Targets', { type: 'upload-targets', page }).row();
        }
        visibleItems.forEach(item => {
            if (kind === 'senders') {
                return;
            } else if (kind === 'targets') {
                actionButton(keyboard, item, { type: 'target-details', filename: item, page });
            } else if (kind === 'results') {
                actionButton(keyboard, item, { type: 'result-details', filename: item, page });
            }
            keyboard.row();
            if (kind === 'targets') {
                actionButton(keyboard, 'Remove', {
                    type: 'confirm',
                    action: { type: 'delete-target', filename: item },
                    returnTo: { type: 'show-targets', page }
                }).row();
            } else if (kind === 'results') {
                actionButton(keyboard, 'Send file', { type: 'send-result', filename: item });
                actionButton(keyboard, 'Remove', {
                    type: 'confirm',
                    action: { type: 'delete-result', filename: item },
                    returnTo: { type: 'show-results', page }
                }).row();
            }
        });

        if (pageCount > 1) {
            if (page > 0) actionButton(keyboard, '⬅️ Previous', { type: `show-${kind}`, page: page - 1 });
            if (page + 1 < pageCount) actionButton(keyboard, 'Next ➡️', { type: `show-${kind}`, page: page + 1 });
            keyboard.row();
        }
        addMenuButton(keyboard).row();

        const emptyMessage = kind === 'results'
            ? 'No results with findings are available yet.'
            : kind === 'targets'
                    ? 'Send a .txt or .xlsx document to this chat using Upload Targets.'
                    : 'No sender sessions found. Add a sender from the Senders menu.';
        const text = kind === 'senders'
            ? `${config.heading}\n\n${items.length ? '🟢 Active · 🟡 Checking · ⚪ Inactive' : emptyMessage}${pageCount > 1 ? `\nPage ${page + 1} of ${pageCount}` : ''}`
            : kind === 'targets'
            ? `${config.heading}\n\n${message ? `${message}\n` : ''}${items.length ? 'Choose a target to manage it. Select the active target from the main menu.' : emptyMessage}${pageCount > 1 ? `\nPage ${page + 1} of ${pageCount}` : ''}`
            : items.length
                ? `${config.heading} · page ${page + 1} of ${pageCount}`
                : `${config.heading}\n\n${emptyMessage}`;
        const result = await present(ctx, text, keyboard);
        if (kind === 'senders' && senderHealth.checking) {
            const messageId = ctx.callbackQuery?.message?.message_id || result?.message_id;
            if (messageId) scheduleSenderViewRefresh(ctx.chat.id, messageId, page);
        }
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
                    api('/api/senders'),
                    api('/api/senders/health?refresh=0&wait=1')
                ]);
                if (senderViewTokens.get(chatId) !== token) return;

                const { page: currentPage, pageCount, items } = paginateItems(response.senders, page);
                const statuses = new Map(health.senders.map(item => [item.folder, item]));
                const keyboard = createSenderListKeyboard(items, statuses, currentPage);
                if (pageCount > 1) {
                    if (currentPage > 0) actionButton(keyboard, '⬅️ Previous', {
                        type: 'show-senders',
                        page: currentPage - 1
                    });
                    if (currentPage + 1 < pageCount) actionButton(keyboard, 'Next ➡️', {
                        type: 'show-senders',
                        page: currentPage + 1
                    });
                    keyboard.row();
                }
                addMenuButton(keyboard).row();
                await bot.api.editMessageText(
                    chatId,
                    messageId,
                    items.length
                        ? `👤 Sender sessions · page ${currentPage + 1} of ${pageCount}`
                        : '👤 Sender sessions\n\nNo sender sessions found. Add a sender from the Senders menu.',
                    { reply_markup: keyboard }
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

    const showItemDetails = async (ctx, kind, item, page) => {
        const keyboard = new InlineKeyboard();
        let text;
        if (kind === 'target') {
            text = `Target list\n${item}`;
            actionButton(keyboard, 'Remove target', {
                type: 'confirm',
                action: { type: 'delete-target', filename: item },
                returnTo: { type: 'show-targets', page }
            }).row();
        } else {
            text = `Scan result\n${item}`;
            actionButton(keyboard, 'Send result file', { type: 'send-result', filename: item });
            actionButton(keyboard, 'Remove result', {
                type: 'confirm',
                action: { type: 'delete-result', filename: item },
                returnTo: { type: 'show-results', page }
            }).row();
        }
        actionButton(keyboard, '⬅️ Back to list', { type: `show-${kind === 'target' ? 'targets' : 'results'}`, page });
        addMenuButton(keyboard).row();
        return present(ctx, text, keyboard);
    };

    const beginScanForActiveTarget = async ctx => {
        const [{ targets, checkpoints }, { senders }] = await Promise.all([
            api('/api/targets'),
            api('/api/senders')
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
        actionButton(keyboard, '⬅️ Back to menu', { type: 'main-menu' }).row();
        return present(ctx, `Choose the number of targets per batch for ${selection.target}:`, keyboard);
    };

    const startSenderPairing = async (ctx, phoneNumber) => {
        await api('/api/senders', jsonPost({ phoneNumber }));
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
        const { results } = await api('/api/results');
        if (!results.includes(filename)) throw new Error('Result not found.');
        await ctx.replyWithDocument(
            new InputFile(path.join(process.cwd(), filename), filename),
            { caption: filename }
        );
    };

    const startScan = async (ctx, selection, resume) => {
        const { senders } = await api('/api/senders');
        if (!senders.length) throw new Error('No sender sessions are available. Add a sender first.');
        await api('/api/scan', jsonPost({
            targetFile: selection.target,
            sessionFolders: senders,
            batchSize: selection.batchSize,
            resume
        }));
        await showMainMenu(
            ctx,
            `Scan started for ${selection.target} using all active senders (${selection.batchSize} targets per batch).`
        );
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
        const keyboard = new InlineKeyboard();
        actionButton(keyboard, '✅ Confirm', { type: 'confirm', action, returnTo });
        actionButton(keyboard, 'Cancel', { type: 'cancel', returnTo });
        return present(ctx, message, keyboard);
    };

    const shutdownLocalApplication = async ctx => {
        await ctx.reply('The local cekbio application is shutting down.');
        await new Promise(resolve => setTimeout(resolve, 500));
        await api('/api/shutdown', jsonPost({ confirm: true }));
    };

    const performAction = async (ctx, action) => {
        const targetPath = filename => `/api/targets/${encodeURIComponent(filename)}`;
        const resultPath = filename => `/api/results/${encodeURIComponent(filename)}`;

        switch (action.type) {
            case 'delete-sender':
                await api(`/api/senders/${encodeURIComponent(action.folder)}/delete`, jsonPost({ confirm: true }));
                if (!action.suppressMenu) await showMainMenu(ctx, `Sender ${action.folder} was removed.`);
                return;
            case 'delete-target':
                await api(`${targetPath(action.filename)}/delete`, jsonPost({ confirm: true }));
                if (activeTargetSelection.get() === action.filename) activeTargetSelection.clear();
                if (!action.suppressMenu) await showMainMenu(ctx, `Target list ${action.filename} and its checkpoint were removed.`);
                return;
            case 'delete-result':
                await api(`${resultPath(action.filename)}/delete`, jsonPost({ confirm: true }));
                if (!action.suppressMenu) await showMainMenu(ctx, `Result ${action.filename} was removed.`);
                return;
            case 'send-result':
                await sendResults(ctx, action.filename);
                await showMainMenu(ctx, `${action.filename} was sent.`);
                return;
            case 'show-status':
                await showStatus(ctx);
                return;
            case 'main-menu':
                pendingBatchSizes.delete(String(ctx.from.id));
                pendingSenderNumbers.delete(String(ctx.from.id));
                await showMainMenu(ctx);
                return;
            case 'show-senders':
                await showCollection(ctx, 'senders', action.page);
                return;
            case 'refresh-senders':
                await showCollection(ctx, 'senders', action.page);
                return;
            case 'show-targets':
                await showCollection(ctx, 'targets', action.page);
                return;
            case 'show-results':
                await showCollection(ctx, 'results', action.page);
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
                    actionButton(keyboard, '⬅️ Back to menu', {
                        type: 'main-menu-page',
                        page: action.page || 0
                    });
                } else {
                    actionButton(keyboard, '⬅️ Back to Targets', {
                        type: 'show-targets',
                        page: action.page || 0
                    });
                }
                actionButton(keyboard, 'Cancel', { type: 'main-menu' }).row();
                await present(
                    ctx,
                    'Upload Targets\n\nSend a .txt or .xlsx document to this chat to add a target list.',
                    keyboard
                );
                return;
            }
            case 'select-target': {
                const { targets } = await api('/api/targets');
                activeTargetSelection.select(action.filename, targets);
                if (action.returnToMain) {
                    await showMainMenu(
                        ctx,
                        `Active target set to ${getTargetDisplayName(action.filename)}.`,
                        action.page
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
                await showItemDetails(ctx, 'target', action.filename, action.page);
                return;
            case 'result-details':
                await showItemDetails(ctx, 'result', action.filename, action.page);
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
                await performAction(ctx, { ...action.action, suppressMenu: true });
                if (action.returnTo) await performAction(ctx, action.returnTo);
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
                await shutdownLocalApplication(ctx);
                return;
            default:
                throw new Error('This action is not available.');
        }
    };

    bot.use(async (ctx, next) => {
        if (!isAuthorizedUpdate(ctx, ownerId)) {
            if (ctx.callbackQuery) await ctx.answerCallbackQuery();
            return;
        }
        try {
            await api('/api/senders/health');
            senderHealthErrors.delete(String(ctx.chat?.id));
        } catch (error) {
            const chatId = String(ctx.chat?.id);
            if (!senderHealthErrors.has(chatId)) {
                senderHealthErrors.add(chatId);
                console.error('Automatic sender health check failed:', error.message);
            }
        }
        await next();
    });

    bot.callbackQuery(/^a:/, async ctx => {
        const action = actions.consume(ctx.callbackQuery.data);
        await ctx.answerCallbackQuery();
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
    bot.callbackQuery('noop', async ctx => ctx.answerCallbackQuery());

    bot.command(['start', 'help'], async ctx => {
        await showMainMenu(ctx, 'Choose an action below.');
    });

    bot.command('status', ctx => showStatus(ctx));
    bot.command('senders', ctx => showCollection(ctx, 'senders'));
    bot.command('targets', ctx => showCollection(ctx, 'targets'));
    bot.command('results', ctx => showCollection(ctx, 'results'));
    bot.command('scan', ctx => beginScanForActiveTarget(ctx));

    bot.command('addsender', async ctx => {
        const phoneNumber = String(ctx.match || '').trim();
        if (!phoneNumber || phoneNumber.replace(/\D/g, '').length < 6) {
            await promptSenderPhone(ctx);
            return;
        }
        await startSenderPairing(ctx, phoneNumber);
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
                await ctx.reply('Enter a valid phone number including country code, or use Cancel.');
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
            await ctx.reply('Batch size must be a positive whole number. Try again or use Cancel.');
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
            await ctx.reply('Only .txt and .xlsx target files are supported.');
            return;
        }
        if (document.file_size > MAX_UPLOAD_BYTES) {
            await ctx.reply('The target file must be no larger than 10 MB.');
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
                const result = await api('/api/targets', jsonPost({ name: filename, contents: text }));
                await showMainMenu(ctx, `Target list ${result.target} was uploaded. Choose it below to make it active.`);
            } else {
                const result = await api('/api/targets/xlsx', jsonPost({
                    name: filename,
                    contentsBase64: contents.toString('base64')
                }));
                await showMainMenu(ctx, `${result.message} Choose the target below to make it active.`);
            }
        } catch (error) {
            await ctx.reply(error.message || 'The target file could not be uploaded.');
        }
    });

    bot.catch(async error => {
        try {
            await error.ctx.reply('The bot could not complete that request. Check the local application and try again.');
        } catch {
            console.error('Telegram update failed; check bot connectivity and the local application.');
        }
    });

    await bot.init();
    await bot.api.setMyCommands([
        { command: 'start', description: 'Open the button menu' },
        { command: 'help', description: 'Show the button menu and help' },
        { command: 'status', description: 'Show scan and sender status' },
        { command: 'senders', description: 'List and manage sender sessions' },
        { command: 'targets', description: 'List and manage target lists' },
        { command: 'results', description: 'Send or remove generated results' },
        { command: 'scan', description: 'Start a scan' },
        { command: 'addsender', description: 'Add a sender session' },
        { command: 'shutdown', description: 'Stop the local application' }
    ]);

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
            return bot.stop();
        },
        polling
    };
};

module.exports = {
    addPairingCodeCopyButton,
    buildMainMenuKeyboard,
    createActionRegistry,
    createActiveTargetSelection,
    formatSenderButtonLabel,
    formatTargetButtonLabel,
    formatMainMenuText,
    getTargetDisplayName,
    getVisiblePairingCode,
    isAuthorizedUpdate,
    isPairingInProgress,
    shouldContinuePairingRefresh,
    isResultFilename,
    paginateItems,
    startTelegramBot,
    validateTelegramConfig
};
