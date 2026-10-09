const crypto = require('crypto');
const path = require('path');
const { Bot, InlineKeyboard, InputFile } = require('grammy');

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const RESULT_PATTERN = /^result_(business|personal|unregistered)_(.+)\.txt$/;
const ACTION_TTL_MS = 10 * 60 * 1000;

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

const startTelegramBot = async ({ token, ownerId, baseUrl, onError = () => {} }) => {
    validateTelegramConfig({ token, ownerId });
    ownerId = String(Number(ownerId));

    const bot = new Bot(token);
    const api = createApiClient(baseUrl);
    const actions = new Map();
    const pendingBatchSizes = new Map();

    const registerAction = (payload) => {
        const now = Date.now();
        for (const [key, entry] of actions) {
            if (entry.expiresAt <= now) actions.delete(key);
        }
        const key = crypto.randomBytes(6).toString('hex');
        actions.set(key, { ...payload, expiresAt: now + ACTION_TTL_MS });
        return `a:${key}`;
    };

    const actionButton = (keyboard, label, payload) => {
        keyboard.text(label, registerAction(payload));
        return keyboard;
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
        await ctx.reply(`Scan started for ${selection.target} using ${selection.sender} (${selection.batchSize} targets per batch). Use /status to check progress.`);
    };

    const requestCheckpointChoice = async (ctx, selection) => {
        if (!selection.hasCheckpoint) {
            await startScan(ctx, selection, false);
            return;
        }
        const keyboard = new InlineKeyboard();
        if (!selection.checkpoint?.invalid) {
            actionButton(keyboard, 'Resume checkpoint', { type: 'scan-start', selection, resume: true });
        }
        actionButton(keyboard, 'Start over', { type: 'scan-start', selection, resume: false });
        await ctx.reply(
            selection.checkpoint?.invalid
                ? 'The checkpoint is invalid. Start a new scan from the beginning?'
                : `A checkpoint exists at batch ${selection.checkpoint.batchIndex} of ${selection.checkpoint.totalBatches}. Resume or start over?`,
            { reply_markup: keyboard }
        );
    };

    const askConfirmation = async (ctx, message, action) => {
        const keyboard = new InlineKeyboard();
        actionButton(keyboard, 'Confirm', { type: 'confirm', action });
        actionButton(keyboard, 'Cancel', { type: 'cancel' });
        await ctx.reply(message, { reply_markup: keyboard });
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
                await ctx.reply(`Status check started for ${action.folder}.`);
                return;
            case 'delete-sender':
                await api(`${folderPath(action.folder)}/delete`, jsonPost({ confirm: true }));
                await ctx.reply(`Sender ${action.folder} was removed.`);
                return;
            case 'delete-target':
                await api(`${targetPath(action.filename)}/delete`, jsonPost({ confirm: true }));
                await ctx.reply(`Target list ${action.filename} and its checkpoint were removed.`);
                return;
            case 'delete-result':
                await api(`${resultPath(action.filename)}/delete`, jsonPost({ confirm: true }));
                await ctx.reply(`Result ${action.filename} was removed.`);
                return;
            case 'check-all':
                await api('/api/senders/check-all', { method: 'POST' });
                await ctx.reply('Sender checks started. Use /status to see the results.');
                return;
            case 'clean-senders':
                await api('/api/senders/clean', jsonPost({ confirm: true }));
                await ctx.reply('Sender cleanup started. Use /status to see the results.');
                return;
            case 'send-result':
                await sendResults(ctx, action.filename);
                return;
            case 'scan-target': {
                const [senders, targetData] = await Promise.all([
                    api('/api/senders'),
                    api('/api/targets')
                ]);
                if (!senders.senders.length) {
                    await ctx.reply('No sender sessions are available. Add a sender first with /addsender <phone number>.');
                    return;
                }
                const checkpoint = targetData.checkpoints[action.target];
                const keyboard = new InlineKeyboard();
                for (const sender of senders.senders) {
                    actionButton(keyboard, sender, {
                        type: 'scan-sender',
                        target: action.target,
                        sender,
                        checkpoint,
                        hasCheckpoint: Boolean(checkpoint)
                    }).row();
                }
                await ctx.reply(`Choose a sender for ${action.target}:`, { reply_markup: keyboard });
                return;
            }
            case 'scan-sender': {
                pendingBatchSizes.set(String(ctx.from.id), {
                    target: action.target,
                    sender: action.sender,
                    checkpoint: action.checkpoint,
                    hasCheckpoint: action.hasCheckpoint,
                    expiresAt: Date.now() + ACTION_TTL_MS
                });
                const keyboard = new InlineKeyboard();
                for (const size of [25, 50, 100]) {
                    actionButton(keyboard, String(size), {
                        type: 'scan-size',
                        target: action.target,
                        sender: action.sender,
                        checkpoint: action.checkpoint,
                        hasCheckpoint: action.hasCheckpoint,
                        batchSize: size
                    });
                }
                actionButton(keyboard, 'Custom size', { type: 'scan-custom-size' });
                await ctx.reply('Choose the number of targets per batch:', { reply_markup: keyboard });
                return;
            }
            case 'scan-custom-size':
                await ctx.reply('Send a positive whole number for the batch size.');
                return;
            case 'scan-size':
                pendingBatchSizes.delete(String(ctx.from.id));
                await requestCheckpointChoice(ctx, {
                    target: action.target,
                    sender: action.sender,
                    checkpoint: action.checkpoint,
                    hasCheckpoint: action.hasCheckpoint,
                    batchSize: action.batchSize
                });
                return;
            case 'scan-start':
                pendingBatchSizes.delete(String(ctx.from.id));
                await startScan(ctx, action.selection, action.resume);
                return;
            case 'confirm':
                await performAction(ctx, action.action);
                return;
            case 'cancel':
                await ctx.reply('Action cancelled.');
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

    bot.callbackQuery(/^a:([a-f0-9]+)$/, async ctx => {
        const key = ctx.match[1];
        const action = actions.get(key);
        actions.delete(key);
        await ctx.answerCallbackQuery();
        if (!action || action.expiresAt <= Date.now()) {
            await ctx.reply('This button has expired. Please run the command again.');
            return;
        }
        try {
            if (action.type === 'confirm') await performAction(ctx, action.action);
            else if (action.type === 'cancel') await ctx.reply('Action cancelled.');
            else if (action.type === 'shutdown') {
                await shutdownLocalApplication(ctx);
            } else await performAction(ctx, action);
        } catch (error) {
            await ctx.reply(error.message || 'The operation could not be completed.');
        }
    });
    bot.callbackQuery('noop', async ctx => ctx.answerCallbackQuery());

    bot.command(['start', 'help'], async ctx => {
        await ctx.reply([
            'cekbio local control',
            '',
            '/status — show scan and sender operation status',
            '/senders — list, check, or remove sender sessions',
            '/targets — list or remove target lists',
            '/results — send or remove generated result files',
            '/scan — choose a target, sender, and batch size',
            '/addsender <phone> — start sender pairing',
            '/checkall — check all sender sessions',
            '/clean — confirm removal of inactive senders',
            '/shutdown — confirm local application shutdown',
            '',
            'You can send a .txt or .xlsx document here to add a target list. Only your private chat is authorized.'
        ].join('\n'));
    });

    bot.command('status', async ctx => {
        const { scan, sender } = await api('/api/status');
        const lines = [`Scan: ${scan?.status || 'idle'}`];
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
        await ctx.reply(lines.join('\n'));
    });

    bot.command('senders', async ctx => {
        const { senders } = await api('/api/senders');
        if (!senders.length) {
            await ctx.reply('No sender sessions found.');
            return;
        }
        const keyboard = new InlineKeyboard();
        for (const [index, folder] of senders.entries()) {
            keyboard.text(`${index + 1}. ${folder}`, 'noop').row();
            actionButton(keyboard, 'Check', { type: 'check-sender', folder });
            actionButton(keyboard, 'Remove', {
                type: 'confirm',
                action: { type: 'delete-sender', folder }
            }).row();
        }
        actionButton(keyboard, 'Check all senders', { type: 'check-all' }).row();
        await ctx.reply('Sender sessions:', { reply_markup: keyboard });
    });

    bot.command('targets', async ctx => {
        const { targets } = await api('/api/targets');
        if (!targets.length) {
            await ctx.reply('No target lists found. Send a .txt or .xlsx document to upload one.');
            return;
        }
        const keyboard = new InlineKeyboard();
        for (const [index, filename] of targets.entries()) {
            keyboard.text(`${index + 1}. ${filename}`.slice(0, 60), 'noop').row();
            actionButton(keyboard, 'Remove', {
                type: 'confirm',
                action: { type: 'delete-target', filename }
            }).row();
        }
        await ctx.reply('Target lists:', { reply_markup: keyboard });
    });

    bot.command('results', async ctx => {
        const { results } = await api('/api/results');
        if (!results.length) {
            await ctx.reply('No results with findings are available.');
            return;
        }
        const keyboard = new InlineKeyboard();
        for (const [index, filename] of results.entries()) {
            if (!isResultFilename(filename)) continue;
            keyboard.text(`${index + 1}. ${filename}`.slice(0, 60), 'noop').row();
            actionButton(keyboard, `Send #${index + 1}`, { type: 'send-result', filename });
            actionButton(keyboard, `Remove #${index + 1}`, {
                type: 'confirm',
                action: { type: 'delete-result', filename }
            }).row();
        }
        await ctx.reply('Generated results (only result_*.txt files can be sent):', { reply_markup: keyboard });
    });

    bot.command('scan', async ctx => {
        const { targets } = await api('/api/targets');
        if (!targets.length) {
            await ctx.reply('No target lists found. Send a .txt or .xlsx document to upload one.');
            return;
        }
        const keyboard = new InlineKeyboard();
        for (const filename of targets) {
            actionButton(keyboard, filename.slice(0, 50), { type: 'scan-target', target: filename }).row();
        }
        await ctx.reply('Choose a target list:', { reply_markup: keyboard });
    });

    bot.command('addsender', async ctx => {
        const phoneNumber = String(ctx.match || '').trim();
        if (!phoneNumber || phoneNumber.replace(/\D/g, '').length < 6) {
            await ctx.reply('Usage: /addsender <phone number>');
            return;
        }
        await api('/api/senders', jsonPost({ phoneNumber }));
        await ctx.reply('Sender pairing started. Use /status to retrieve the pairing code in this private chat.');
    });

    bot.command('checkall', async ctx => {
        await api('/api/senders/check-all', { method: 'POST' });
        await ctx.reply('Sender checks started. Use /status to see the results.');
    });

    bot.command('clean', async ctx => {
        await askConfirmation(ctx, 'Check all senders and remove sessions that are inactive or logged out?', {
            type: 'clean-senders'
        });
    });

    bot.command('shutdown', async ctx => {
        await askConfirmation(ctx, 'Shut down the local cekbio application? This does not shut down Windows.', {
            type: 'shutdown'
        });
    });

    bot.on('message:text', async (ctx, next) => {
        if (ctx.message.text.startsWith('/')) return next();
        const pending = pendingBatchSizes.get(String(ctx.from.id));
        if (!pending) return next();
        pendingBatchSizes.delete(String(ctx.from.id));
        if (pending.expiresAt <= Date.now()) {
            await ctx.reply('Batch size selection expired. Run /scan again.');
            return;
        }
        const batchSize = Number(ctx.message.text.trim());
        if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
            await ctx.reply('Batch size must be a positive whole number. Run /scan again.');
            return;
        }
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
    isAuthorizedUpdate,
    isResultFilename,
    startTelegramBot,
    validateTelegramConfig
};
