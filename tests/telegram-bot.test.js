const test = require('node:test');
const assert = require('node:assert/strict');
const { InlineKeyboard } = require('grammy');

const {
    addPairingCodeCopyButton,
    buildMainMenuKeyboard,
    buildScanProgressKeyboard,
    buildStatusKeyboard,
    buildSenderSessionsKeyboard,
    createActionRegistry,
    createActiveTargetSelection,
    createDashboardPresenter,
    editShutdownNotice,
    formatSenderButtonLabel,
    formatScanProgress,
    formatSenderSessionsText,
    formatTargetButtonLabel,
    formatMainMenuText,
    getActionButtonStyle,
    getSenderButtonStyle,
    getTargetButtonStyle,
    getTargetDisplayName,
    getVisiblePairingCode,
    isAuthorizedUpdate,
    isPairingInProgress,
    isResultFilename,
    paginateItems,
    shouldContinuePairingRefresh,
    validateTelegramConfig,
    TELEGRAM_COMMANDS
} = require('../telegram/bot');

test('Telegram configuration requires a bot token and numeric owner ID', () => {
    assert.throws(
        () => validateTelegramConfig({ token: '', ownerId: '12345' }),
        /TELEGRAM_BOT_TOKEN/
    );
    assert.throws(
        () => validateTelegramConfig({ token: 'token', ownerId: 'owner' }),
        /TELEGRAM_OWNER_ID/
    );
    assert.throws(
        () => validateTelegramConfig({ token: 'token', ownerId: '0' }),
        /TELEGRAM_OWNER_ID/
    );
    assert.doesNotThrow(() => validateTelegramConfig({ token: 'token', ownerId: '12345' }));
});

test('only the configured owner in a one-to-one private chat is authorized', () => {
    const ownerUpdate = { from: { id: 12345 }, chat: { id: 12345, type: 'private' } };
    assert.equal(isAuthorizedUpdate(ownerUpdate, '12345'), true);
    assert.equal(isAuthorizedUpdate({ ...ownerUpdate, from: { id: 56789 } }, '12345'), false);
    assert.equal(isAuthorizedUpdate({ ...ownerUpdate, chat: { id: -12345, type: 'group' } }, '12345'), false);
    assert.equal(isAuthorizedUpdate({ ...ownerUpdate, chat: { id: -12345, type: 'supergroup' } }, '12345'), false);
    assert.equal(isAuthorizedUpdate({ chat: { id: 12345, type: 'private' } }, '12345'), false);
});

test('only flat generated result text files may be sent to Telegram', () => {
    assert.equal(isResultFilename('result_business_targets.txt'), true);
    assert.equal(isResultFilename('result_personal_targets with spaces.txt'), true);
    assert.equal(isResultFilename('target_business_targets.json'), false);
    assert.equal(isResultFilename('report_business_targets.txt'), false);
    assert.equal(isResultFilename('../result_business_targets.txt'), false);
    assert.equal(isResultFilename('result_business_targets.json'), false);
});

test('list pagination clamps page numbers and returns stable page counts', () => {
    assert.deepEqual(paginateItems(['a', 'b', 'c'], 1, 2), {
        page: 1,
        pageCount: 2,
        items: ['c']
    });
    assert.deepEqual(paginateItems(['a', 'b', 'c'], 20, 2), {
        page: 1,
        pageCount: 2,
        items: ['c']
    });
    assert.deepEqual(paginateItems([], 0, 2), {
        page: 0,
        pageCount: 1,
        items: []
    });
    assert.throws(() => paginateItems([], 0, 0), /positive integer/);
});

test('inline actions can only be consumed once and expire', () => {
    let now = 1_000;
    const registry = createActionRegistry(() => now);
    const callbackData = registry.create({ type: 'show-status' });

    assert.match(callbackData, /^a:[a-f0-9]{12}$/);
    assert.deepEqual(registry.consume(callbackData), { type: 'show-status' });
    assert.equal(registry.consume(callbackData), null);

    const expiredCallback = registry.create({ type: 'show-results' });
    now += 10 * 60 * 1000;
    assert.equal(registry.consume(expiredCallback), null);
    assert.equal(registry.consume('invalid'), null);
});

test('pairing-code copy button copies only the code', () => {
    const keyboard = addPairingCodeCopyButton(new InlineKeyboard(), '581204');
    const copyButton = keyboard.inline_keyboard.flat().find(button => button.copy_text);

    assert.equal(copyButton.text, '🔑 581204');
    assert.deepEqual(copyButton.copy_text, { text: '581204' });
    assert.equal(copyButton.style, 'primary');
});

test('status and progress keyboards omit manual Refresh buttons', () => {
    const callbackData = payload => JSON.stringify(payload);
    const statusKeyboard = buildStatusKeyboard({
        pairingCode: '581204',
        callbackData
    });
    const progressKeyboard = buildScanProgressKeyboard(callbackData);
    const statusLabels = statusKeyboard.inline_keyboard.flat().map(button => button.text);
    const progressLabels = progressKeyboard.inline_keyboard.flat().map(button => button.text);

    assert.deepEqual(statusLabels, ['🔑 581204', '🏠 Main menu']);
    assert.deepEqual(progressLabels, ['🏠 Main menu']);
    assert.ok([...statusLabels, ...progressLabels].every(label => !/refresh/i.test(label)));
    assert.deepEqual(JSON.parse(statusKeyboard.inline_keyboard[1][0].callback_data), { type: 'main-menu' });
    assert.deepEqual(JSON.parse(progressKeyboard.inline_keyboard[0][0].callback_data), { type: 'main-menu' });
});

test('dashboard creates one control message and edits it for later updates', async () => {
    const sent = [];
    const edited = [];
    const dashboard = createDashboardPresenter({
        sendMessage: async (...args) => {
            sent.push(args);
            return { message_id: 41 };
        },
        editMessageText: async (...args) => edited.push(args)
    });
    const keyboard = new InlineKeyboard().text('Next', 'next');

    assert.deepEqual(await dashboard.present(123, null, 'Home', keyboard), { message_id: 41 });
    assert.deepEqual(await dashboard.present(123, null, 'Status', keyboard), { message_id: 41 });
    assert.equal(sent.length, 1);
    assert.equal(edited.length, 1);
    assert.equal(dashboard.getMessageId(123), 41);
    assert.deepEqual(edited[0].slice(0, 3), [123, 41, 'Status']);
});

test('dashboard uses callback message when no in-memory dashboard exists', async () => {
    const edited = [];
    const dashboard = createDashboardPresenter({
        sendMessage: async () => assert.fail('A new dashboard should not be sent.'),
        editMessageText: async (...args) => edited.push(args)
    });

    await dashboard.present(123, 77, 'Updated', new InlineKeyboard());

    assert.equal(dashboard.getMessageId(123), 77);
    assert.equal(edited[0][1], 77);
});

test('dashboard treats an unchanged Telegram message as updated without sending a duplicate', async () => {
    let sendCount = 0;
    const dashboard = createDashboardPresenter({
        sendMessage: async () => ({ message_id: ++sendCount }),
        editMessageText: async () => {
            throw Object.assign(new Error('message is not modified'), {
                description: 'Bad Request: message is not modified'
            });
        }
    });

    assert.deepEqual(await dashboard.present(123, null, 'Same', new InlineKeyboard()), { message_id: 1 });
    assert.deepEqual(await dashboard.present(123, null, 'Same', new InlineKeyboard()), { message_id: 1 });
    assert.equal(sendCount, 1);
});

test('dashboard replaces an uneditable control message, but surfaces other API errors', async () => {
    let sendCount = 0;
    let shouldFail = true;
    const dashboard = createDashboardPresenter({
        sendMessage: async () => ({ message_id: ++sendCount + 100 }),
        editMessageText: async () => {
            if (shouldFail) {
                shouldFail = false;
                throw Object.assign(new Error('message not found'), {
                    description: 'Bad Request: message to edit not found'
                });
            }
            throw new Error('Telegram network unavailable');
        }
    });

    assert.deepEqual(await dashboard.present(123, null, 'First', new InlineKeyboard()), { message_id: 101 });
    assert.deepEqual(await dashboard.present(123, null, 'Second', new InlineKeyboard()), { message_id: 102 });
    await assert.rejects(
        dashboard.present(123, null, 'Third', new InlineKeyboard()),
        /network unavailable/
    );
    assert.equal(sendCount, 2);
});

test('target buttons show friendly names and a single active target can be replaced', () => {
    const firstTarget = 'target_business_custom-list.txt';
    const secondTarget = 'target_personal_custom-list.txt';
    const selection = createActiveTargetSelection();

    assert.equal(getTargetDisplayName(firstTarget), 'business_custom-list');
    assert.equal(formatTargetButtonLabel(firstTarget), 'business_custom-list');
    assert.equal(getTargetButtonStyle(false), 'danger');
    assert.equal(getTargetButtonStyle(true), 'success');
    assert.equal(selection.get(), null);
    assert.equal(selection.select(firstTarget, [firstTarget, secondTarget]), firstTarget);
    assert.equal(selection.select(secondTarget, [firstTarget, secondTarget]), secondTarget);
    assert.equal(selection.get(), secondTarget);
    assert.equal(selection.reconcile([firstTarget]), null);
    assert.throws(() => selection.select(secondTarget, [firstTarget]), /not found/);
});

test('sender labels show connected, checking, and unavailable states clearly', () => {
    assert.equal(formatSenderButtonLabel('session_1'), 'session_1');
    assert.equal(formatSenderButtonLabel('session_2'), 'session_2');
    assert.equal(formatSenderButtonLabel('session_3'), 'session_3');
    assert.equal(formatSenderButtonLabel('session_4'), 'session_4');
    assert.equal(getSenderButtonStyle('alive'), 'success');
    assert.equal(getSenderButtonStyle('active'), 'success');
    assert.equal(getSenderButtonStyle('scanning'), 'success');
    assert.equal(getSenderButtonStyle('checking'), 'primary');
    assert.equal(getSenderButtonStyle('unknown'), 'primary');
    assert.equal(getSenderButtonStyle('timeout/dead'), 'danger');
    assert.equal(getSenderButtonStyle('banned/logged_out'), 'danger');
    assert.equal(getSenderButtonStyle('error'), 'danger');
});

test('ordinary Telegram actions are blue and destructive or cancel actions are red', () => {
    assert.equal(getActionButtonStyle('Status', { type: 'show-status' }), 'primary');
    assert.equal(getActionButtonStyle('Confirm', { type: 'confirm' }), 'primary');
    assert.equal(getActionButtonStyle('Shutdown', { type: 'shutdown' }), 'primary');
    assert.equal(getActionButtonStyle('Cancel', { type: 'cancel' }), 'danger');
    assert.equal(getActionButtonStyle('Remove', { type: 'delete-target' }), 'danger');
    assert.equal(getActionButtonStyle('Remove result', { type: 'delete-result' }), 'danger');
});

test('Sender sessions keeps the same heading and status legend across refreshes', () => {
    const initial = formatSenderSessionsText(0, 1, 1);
    const refreshed = formatSenderSessionsText(0, 1, 1);

    assert.equal(initial, refreshed);
    assert.equal(initial, '👤 Sender sessions\n\nGreen = Active · Blue = Checking · Red = Inactive');
    assert.match(formatSenderSessionsText(1, 2, 7), /Page 2 of 2/);
    assert.match(formatSenderSessionsText(0, 1, 0), /No sender sessions found/);
});

test('Sender sessions keyboard keeps Add sender, sender actions, pagination, and Main menu ordered', () => {
    const keyboard = buildSenderSessionsKeyboard({
        senders: ['session_active', 'session_checking', 'session_inactive'],
        statuses: new Map([
            ['session_active', { status: 'alive' }],
            ['session_checking', { status: 'checking' }],
            ['session_inactive', { status: 'timeout/dead' }]
        ]),
        page: 0,
        pageCount: 1,
        callbackData: payload => JSON.stringify(payload)
    });
    const rows = keyboard.inline_keyboard;
    const labels = rows.map(row => row[0].text);

    assert.deepEqual(labels, [
        '➕ Add sender', 'session_active', 'Remove',
        'session_checking', 'Remove',
        'session_inactive', 'Remove',
        '🏠 Main menu'
    ]);
    assert.deepEqual(rows.map(row => row[0].style), [
        'primary', 'success', 'danger', 'primary', 'danger', 'danger', 'danger', 'primary'
    ]);
    assert.deepEqual(JSON.parse(rows[1][0].callback_data), { type: 'refresh-senders', page: 0 });
    assert.deepEqual(JSON.parse(rows[4][0].callback_data), {
        type: 'confirm',
        action: { type: 'delete-sender', folder: 'session_checking' },
        returnTo: { type: 'show-senders', page: 0 }
    });
    assert.ok(labels.every(label => !/[✅◯🟢🟡⚪]/u.test(label)));
});

test('Telegram exposes only /start and /shutdown slash commands', () => {
    assert.deepEqual(TELEGRAM_COMMANDS.map(({ command }) => command), ['start', 'shutdown']);
});

test('confirming shutdown edits the confirmation message and removes its buttons', async () => {
    let edit;
    await editShutdownNotice(async (text, options) => {
        edit = { text, options };
    });

    assert.equal(edit.text, 'The local cekbio application is shutting down.');
    assert.deepEqual(edit.options.reply_markup.inline_keyboard, []);
});

test('scan progress includes confirmed targets, active batch work, and terminal state', () => {
    const progress = formatScanProgress({
        status: 'running',
        targetFile: 'targets.txt',
        completedTargets: 20,
        totalTargets: 100,
        completedBatches: 2,
        totalBatches: 10,
        activeBatchProgress: [{
            folder: 'session_1',
            batchIndex: 2,
            totalBatches: 10,
            processedTargets: 5,
            totalTargets: 10,
            phase: 'checking profiles'
        }],
        sessionFolders: ['session_1'],
        senderStatuses: { session_1: { status: 'scanning' } }
    });

    assert.match(progress, /25%/);
    assert.match(progress, /Targets confirmed: 20 \/ 100/);
    assert.match(progress, /Currently processing: 5 \/ 80/);
    assert.match(progress, /session_1: batch 3\/10 · 5 \/ 10 targets/);

    assert.match(formatScanProgress({
        status: 'paused',
        targetFile: 'targets.txt',
        completedTargets: 20,
        totalTargets: 100,
        completedBatches: 2,
        totalBatches: 10
    }), /Progress is saved; resume it from Scan/);
});

test('scan progress shows at most three sender details and reports the remainder', () => {
    const progress = formatScanProgress({
        status: 'running',
        targetFile: 'targets.txt',
        completedTargets: 20,
        totalTargets: 100,
        completedBatches: 2,
        totalBatches: 10,
        sessionFolders: ['s1', 's2', 's3', 's4', 's5'],
        senderStatuses: Object.fromEntries(
            ['s1', 's2', 's3', 's4', 's5'].map(folder => [folder, { status: 'scanning' }])
        ),
        activeBatchProgress: ['s1', 's2', 's3', 's4', 's5'].map((folder, index) => ({
            folder,
            batchIndex: index,
            totalBatches: 10,
            processedTargets: 5,
            totalTargets: 10,
            phase: 'checking profiles'
        }))
    });

    assert.match(progress, /Active senders: 5 \/ 5/);
    assert.match(progress, /s1: batch/);
    assert.match(progress, /s3: batch/);
    assert.doesNotMatch(progress, /s4: batch|s5: batch/);
    assert.match(progress, /\+2 more active senders/);
});

test('scan progress remains below Telegram message limit with unusually long details', () => {
    const progress = formatScanProgress({
        status: 'failed',
        targetFile: 'target'.repeat(1000),
        completedTargets: 20,
        totalTargets: 100,
        completedBatches: 2,
        totalBatches: 10,
        error: 'failure '.repeat(2000),
        sessionFolders: ['s1', 's2', 's3', 's4'],
        senderStatuses: Object.fromEntries(
            ['s1', 's2', 's3', 's4'].map(folder => [folder, { status: 'scanning' }])
        ),
        activeBatchProgress: ['s1', 's2', 's3', 's4'].map(folder => ({
            folder: folder.repeat(200),
            batchIndex: 0,
            totalBatches: 10,
            processedTargets: 1,
            totalTargets: 10,
            phase: 'phase '.repeat(200)
        }))
    });

    assert.ok(progress.length <= 4096);
    assert.match(progress, /Status: failed/);
});

test('start menu shows Targets heading, upload action, and one full-width button per target', () => {
    const targets = ['target_business_one.txt', 'target_personal_two.txt'];
    const keyboard = buildMainMenuKeyboard({
        targets,
        activeTarget: targets[1],
        page: 0,
        callbackData: payload => JSON.stringify(payload)
    });
    const rows = keyboard.inline_keyboard;
    const labels = rows.flat().map(button => button.text);
    const text = formatMainMenuText('Choose an action below.', targets[1], 0, 1, targets.length);

    assert.match(text, /\nTargets\n/);
    assert.deepEqual(rows.slice(0, 3).map(row => row.map(button => button.text)), [
        ['👤 Senders', '🔎 Scan'],
        ['📦 Results'],
        ['⬆️ Upload Targets']
    ]);
    assert.ok(labels.includes('⬆️ Upload Targets'));
    assert.ok(labels.includes('business_one'));
    assert.ok(labels.includes('personal_two'));
    assert.equal(labels.at(-1), '⏻ Shutdown');
    assert.deepEqual(JSON.parse(rows.at(-1)[0].callback_data), { type: 'shutdown' });
    assert.deepEqual(rows.flat().map(button => button.style), [
        'primary', 'primary', 'primary', 'primary', 'danger', 'success', 'primary'
    ]);
    assert.deepEqual(rows.find(row => row[0].text === '⬆️ Upload Targets').map(button => button.text), ['⬆️ Upload Targets']);
    assert.deepEqual(rows.find(row => row[0].text === 'personal_two').map(button => button.text), ['personal_two']);
    assert.ok(labels.every(label => !/[✅◯🟢🟡⚪]/u.test(label)));
    assert.equal(labels.includes('📄 Targets'), false);
    assert.deepEqual(JSON.parse(rows[0][1].callback_data), { type: 'show-scan', page: 0 });
    assert.ok(rows.some(row => row.some(button =>
        button.callback_data && JSON.parse(button.callback_data).type === 'select-target'
    )));

    const runningKeyboard = buildMainMenuKeyboard({
        targets,
        activeTarget: targets[1],
        page: 0,
        scanStatus: 'running',
        callbackData: payload => JSON.stringify(payload)
    });
    assert.equal(runningKeyboard.inline_keyboard[0][1].text, '🔎 Scan progress');
    assert.deepEqual(JSON.parse(runningKeyboard.inline_keyboard[0][1].callback_data), {
        type: 'scan-progress-refresh'
    });

    const pagedTargets = Array.from({ length: 7 }, (_, index) => `target_${index}.txt`);
    const pagedKeyboard = buildMainMenuKeyboard({
        targets: pagedTargets,
        activeTarget: null,
        page: 0,
        callbackData: payload => JSON.stringify(payload)
    });
    assert.deepEqual(pagedKeyboard.inline_keyboard.at(-2).map(button => button.text), ['Next ➡️']);
    assert.equal(pagedKeyboard.inline_keyboard.at(-1)[0].text, '⏻ Shutdown');
});

test('pairing code is available only while the pairing operation is running', () => {
    const runningSender = { status: 'running', pairingCode: '581204' };
    const connectedSender = { status: 'connected', pairingCode: '581204' };

    assert.equal(isPairingInProgress(runningSender), true);
    assert.equal(getVisiblePairingCode(runningSender), '581204');
    assert.equal(isPairingInProgress(connectedSender), false);
    assert.equal(getVisiblePairingCode(connectedSender), null);
    assert.equal(isPairingInProgress({ status: 'running', mode: 'check-all' }), false);
    assert.equal(isPairingInProgress({ status: 'running', sessionFolder: 'sender_1' }), false);
    assert.equal(shouldContinuePairingRefresh(runningSender, 2_000, 1_000), true);
    assert.equal(shouldContinuePairingRefresh(connectedSender, 2_000, 1_000), false);
    assert.equal(shouldContinuePairingRefresh(runningSender, 1_000, 1_000), false);
});
