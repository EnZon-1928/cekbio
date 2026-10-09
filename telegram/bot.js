const crypto = require('crypto');
const path = require('path');
const { Bot, InlineKeyboard, InputFile } = require('grammy');

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const RESULT_PATTERN = /^result_(business|personal|unregistered)_(.+)\.txt$/;
const ACTION_TTL_MS = 10 * 60 * 1000;
const LIST_PAGE_SIZE = 6;

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
    const pendingBatchSizes = new Map();
    const pendingSenderNumbers = new Map();

    const registerAction = (payload) => {
        return actions.create(payload);
    };

    const actionButton = (keyboard, label, payload) => {
        keyboard.text([...String(label)].slice(0, 60).join(''), registerAction(payload));
        return keyboard;
    };

    const present = (ctx, text, replyMarkup) => {
        const options = { reply_markup: replyMarkup };
        return ctx.callbackQuery ? ctx.editMessageText(text, options) : ctx.reply(text, options);
    };

    const mainMenuKeyboard = () => {
        const keyboard = new InlineKeyboard();
        actionButton(keyboard, '📊 Status', { type: 'show-status' });
        actionButton(keyboard, '👤 Senders', { type: 'show-senders', page: 0 }).row();
        actionButton(keyboard, '📄 Targets', { type: 'show-targets', page: 0 });
        actionButton(keyboard, '🔎 Scan', { type: 'show-scan', page: 0 }).row();
        actionButton(keyboard, '📦 Results', { type: 'show-results', page: 0 });
        return keyboard;
    };

    const addMenuButton = (keyboard, label = '🏠 Main menu') => {
        actionButton(keyboard, label, { type: 'main-menu' });
        return keyboard;
    };

    const showMainMenu = (ctx, message = 'What would you like to do?') =>
        present(ctx, `cekbio\n\n${message}`, mainMenuKeyboard());

    const showStatus = async ctx => {
        const { scan, sender } = await api('/api/status');
        const lines = [`📊 cekbio status`, `Scan: ${scan?.status || 'idle'}`];
        if (scan) {
            lines.push(`Target: ${scan.targetFile}`);
            lines.push(`Sender: ${scan.sessionFolder}`);
            lines.push(`Progress: ${scan.completedTargets} / ${scan.totalTargets} targets`);
        }
        lines.push(`Sender operation: ${sender?.status || 'idle'}`);
        if (sender?.sessionFolder) lines.push(`Session: ${sender.sessionFolder}`);
        if (sender?.pairingCode) lines.push(`Pairing code: ${sender.pairingCode}`);
        if (sender?.error) lines.push(`Sender error: ${sender.error}`);
        if (scan?.error) lines.push(`Scan error: ${scan.error}`);
        const keyboard = new InlineKeyboard();
        actionButton(keyboard, '↻ Refresh', { type: 'show-status' });
        addMenuButton(keyboard).row();
        return present(ctx, lines.join('\n'), keyboard);
    };

    const showCollection = async (ctx, kind, requestedPage = 0) => {
        const config = {
            senders: { endpoint: '/api/senders', key: 'senders', heading: '👤 Sender sessions' },
            targets: { endpoint: '/api/targets', key: 'targets', heading: '📄 Target lists' },
            results: { endpoint: '/api/results', key: 'results', heading: '📦 Scan results' },
            scan: { endpoint: '/api/targets', key: 'targets', heading: '🔎 Choose a target to scan' }
        }[kind];
        if (!config) throw new Error('This list is not available.');
        const response = await api(config.endpoint);
        const allItems = response[config.key];
        const items = kind === 'results' ? allItems.filter(isResultFilename) : allItems;
        const { page, pageCount, items: visibleItems } = paginateItems(items, requestedPage);
        const keyboard = new InlineKeyboard();

        if (kind === 'senders') {
            actionButton(keyboard, '➕ Add sender', { type: 'add-sender' }).row();
        }
        visibleItems.forEach(item => {
            if (kind === 'senders') {
                actionButton(keyboard, item, { type: 'sender-details', folder: item, page });
            } else if (kind === 'targets') {
                actionButton(keyboard, item, { type: 'target-details', filename: item, page });
            } else if (kind === 'results') {
                actionButton(keyboard, item, { type: 'result-details', filename: item, page });
            } else {
                actionButton(keyboard, item, { type: 'scan-target', target: item, page });
            }
            keyboard.row();
            if (kind === 'senders') {
                actionButton(keyboard, 'Check', { type: 'check-sender', folder: item, page });
                actionButton(keyboard, 'Remove', {
                    type: 'confirm',
                    action: { type: 'delete-sender', folder: item },
                    returnTo: { type: 'show-senders', page }
                }).row();
            } else if (kind === 'targets') {
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

        if (kind === 'senders' && items.length) {
            actionButton(keyboard, 'Check all', { type: 'check-all' }).row();
            actionButton(keyboard, 'Clean inactive', {
                type: 'confirm',
                action: { type: 'clean-senders' },
                returnTo: { type: 'show-senders', page }
            }).row();
        }
        if (pageCount > 1) {
            if (page > 0) actionButton(keyboard, '⬅️ Previous', { type: `show-${kind}`, page: page - 1 });
            if (page + 1 < pageCount) actionButton(keyboard, 'Next ➡️', { type: `show-${kind}`, page: page + 1 });
            keyboard.row();
        }
        addMenuButton(keyboard).row();

        const emptyMessage = kind === 'results'
            ? 'No results with findings are available yet.'
            : kind === 'scan'
                ? 'No target lists found. Send a .txt or .xlsx document to this chat to add one.'
                : kind === 'targets'
                    ? 'No target lists found. Send a .txt or .xlsx document to this chat to add one.'
                    : 'No sender sessions found. Add a sender from the Senders menu.';
        const text = items.length
            ? `${config.heading} · page ${page + 1} of ${pageCount}`
            : `${config.heading}\n\n${emptyMessage}`;
        return present(ctx, text, keyboard);
    };

    const showItemDetails = async (ctx, kind, item, page) => {
        const keyboard = new InlineKeyboard();
        let text;
        if (kind === 'sender') {
            text = `Sender session\n${item}`;
            actionButton(keyboard, 'Check status', { type: 'check-sender', folder: item, page });
            actionButton(keyboard, 'Remove sender', {
                type: 'confirm',
                action: { type: 'delete-sender', folder: item },
                returnTo: { type: 'show-senders', page }
            }).row();
        } else if (kind === 'target') {
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
        actionButton(keyboard, '⬅️ Back to list', { type: `show-${kind === 'sender' ? 'senders' : kind === 'target' ? 'targets' : 'results'}`, page });
        addMenuButton(keyboard).row();
        return present(ctx, text, keyboard);
    };

    const showScanBatchOptions = async (ctx, selection) => {
        const keyboard = new InlineKeyboard();
        for (const size of [25, 50, 100]) {
            actionButton(keyboard, String(size), {
                type: 'scan-size',
                target: selection.target,
                sender: selection.sender,
                checkpoint: selection.checkpoint,
                hasCheckpoint: selection.hasCheckpoint,
                targetPage: selection.targetPage,
                senderPage: selection.senderPage,
                batchSize: size
            });
        }
        actionButton(keyboard, 'Custom size', {
            type: 'scan-custom-size',
            selection
        }).row();
        actionButton(keyboard, '⬅️ Back to senders', {
            type: 'scan-target',
            target: selection.target,
            page: selection.targetPage || 0,
            senderPage: selection.senderPage || 0
        });
        actionButton(keyboard, 'Cancel', { type: 'main-menu' }).row();
        return present(ctx, 'Choose the number of targets per batch:', keyboard);
    };

    const startSenderPairing = async (ctx, phoneNumber) => {
        await api('/api/senders', jsonPost({ phoneNumber }));
        pendingSenderNumbers.delete(String(ctx.from.id));
        await showMainMenu(ctx, 'Sender pairing started. Open Status to retrieve the pairing code.');
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
        await api('/api/scan', jsonPost({
            targetFile: selection.target,
            sessionFolder: selection.sender,
            batchSize: selection.batchSize,
            resume
        }));
        await showMainMenu(
            ctx,
            `Scan started for ${selection.target} using ${selection.sender} (${selection.batchSize} targets per batch).`
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
                `Ready to scan ${selection.target} with ${selection.sender} (${selection.batchSize} targets per batch).`,
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
                : `A checkpoint exists at batch ${selection.checkpoint.batchIndex} of ${selection.checkpoint.totalBatches}. Resume or start over?`,
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
        const folderPath = folder => `/api/senders/${encodeURIComponent(folder)}`;
        const targetPath = filename => `/api/targets/${encodeURIComponent(filename)}`;
        const resultPath = filename => `/api/results/${encodeURIComponent(filename)}`;

        switch (action.type) {
            case 'check-sender':
                await api(`${folderPath(action.folder)}/check`, { method: 'POST' });
                await showMainMenu(ctx, `Status check started for ${action.folder}.`);
                return;
            case 'delete-sender':
                await api(`${folderPath(action.folder)}/delete`, jsonPost({ confirm: true }));
                if (!action.suppressMenu) await showMainMenu(ctx, `Sender ${action.folder} was removed.`);
                return;
            case 'delete-target':
                await api(`${targetPath(action.filename)}/delete`, jsonPost({ confirm: true }));
                if (!action.suppressMenu) await showMainMenu(ctx, `Target list ${action.filename} and its checkpoint were removed.`);
                return;
            case 'delete-result':
                await api(`${resultPath(action.filename)}/delete`, jsonPost({ confirm: true }));
                if (!action.suppressMenu) await showMainMenu(ctx, `Result ${action.filename} was removed.`);
                return;
            case 'check-all':
                await api('/api/senders/check-all', { method: 'POST' });
                await showMainMenu(ctx, 'Sender checks started. Open Status to see progress.');
                return;
            case 'clean-senders':
                await api('/api/senders/clean', jsonPost({ confirm: true }));
                if (!action.suppressMenu) await showMainMenu(ctx, 'Sender cleanup started. Open Status to see progress.');
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
            case 'show-targets':
                await showCollection(ctx, 'targets', action.page);
                return;
            case 'show-results':
                await showCollection(ctx, 'results', action.page);
                return;
            case 'show-scan':
                await showCollection(ctx, 'scan', action.page);
                return;
            case 'sender-details':
                await showItemDetails(ctx, 'sender', action.folder, action.page);
                return;
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
            case 'scan-target': {
                const [senders, targetData] = await Promise.all([
                    api('/api/senders'),
                    api('/api/targets')
                ]);
                if (!senders.senders.length) {
                    await showMainMenu(ctx, 'No sender sessions are available. Add a sender first from Senders.');
                    return;
                }
                const checkpoint = targetData.checkpoints[action.target];
                const { page, pageCount, items: visibleSenders } = paginateItems(senders.senders, action.senderPage || 0);
                const keyboard = new InlineKeyboard();
                for (const sender of visibleSenders) {
                    actionButton(keyboard, sender, {
                        type: 'scan-sender',
                        target: action.target,
                        sender,
                        checkpoint,
                        hasCheckpoint: Boolean(checkpoint),
                        targetPage: action.page || 0,
                        senderPage: page
                    }).row();
                }
                if (page > 0) {
                    actionButton(keyboard, '⬅️ Previous', {
                        type: 'scan-target',
                        target: action.target,
                        page: action.page || 0,
                        senderPage: page - 1
                    });
                }
                if (page + 1 < pageCount) {
                    actionButton(keyboard, 'Next ➡️', {
                        type: 'scan-target',
                        target: action.target,
                        page: action.page || 0,
                        senderPage: page + 1
                    });
                }
                if (pageCount > 1) {
                    keyboard.row();
                }
                actionButton(keyboard, '⬅️ Back to targets', {
                    type: 'show-scan',
                    page: action.page || 0
                });
                actionButton(keyboard, 'Cancel', { type: 'main-menu' }).row();
                await present(ctx, `Choose a sender for ${action.target}:`, keyboard);
                return;
            }
            case 'scan-sender': {
                await showScanBatchOptions(ctx, action);
                return;
            }
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
                    sender: action.sender,
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
        await next();
    });

    bot.callbackQuery(/^a:/, async ctx => {
        const action = actions.consume(ctx.callbackQuery.data);
        await ctx.answerCallbackQuery();
        if (!action) {
            await showMainMenu(ctx, 'That button expired. Please choose an option again.');
            return;
        }
        try {
            await performAction(ctx, action);
        } catch (error) {
            await showMainMenu(ctx, error.message || 'The operation could not be completed.');
        }
    });
    bot.callbackQuery('noop', async ctx => ctx.answerCallbackQuery());

    bot.command(['start', 'help'], async ctx => {
        await showMainMenu(ctx, 'Choose an action below. You can also send a .txt or .xlsx file to add a target list.');
    });

    bot.command('status', showStatus);
    bot.command('senders', ctx => showCollection(ctx, 'senders'));
    bot.command('targets', ctx => showCollection(ctx, 'targets'));
    bot.command('results', ctx => showCollection(ctx, 'results'));
    bot.command('scan', ctx => showCollection(ctx, 'scan'));

    bot.command('addsender', async ctx => {
        const phoneNumber = String(ctx.match || '').trim();
        if (!phoneNumber || phoneNumber.replace(/\D/g, '').length < 6) {
            await promptSenderPhone(ctx);
            return;
        }
        await startSenderPairing(ctx, phoneNumber);
    });

    bot.command('checkall', async ctx => {
        await api('/api/senders/check-all', { method: 'POST' });
        await showMainMenu(ctx, 'Sender checks started. Open Status to see progress.');
    });

    bot.command('clean', async ctx => {
        await askConfirmation(ctx, 'Check all senders and remove sessions that are inactive or logged out?', {
            type: 'clean-senders'
        }, { type: 'show-senders', page: 0 });
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
                await ctx.reply(`Target list ${result.target} was uploaded.`);
            } else {
                const result = await api('/api/targets/xlsx', jsonPost({
                    name: filename,
                    contentsBase64: contents.toString('base64')
                }));
                await ctx.reply(result.message);
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
        { command: 'checkall', description: 'Check all sender sessions' },
        { command: 'clean', description: 'Remove inactive senders' },
        { command: 'shutdown', description: 'Stop the local application' }
    ]);

    const polling = bot.start({
        onStart: info => console.log(`Telegram bot @${info.username} is connected in private-owner mode.`)
    });
    polling.catch(() => onError());

    return {
        bot,
        stop: () => bot.stop(),
        polling
    };
};

module.exports = {
    createActionRegistry,
    isAuthorizedUpdate,
    isResultFilename,
    paginateItems,
    startTelegramBot,
    validateTelegramConfig
};
