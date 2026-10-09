const test = require('node:test');
const assert = require('node:assert/strict');
const { InlineKeyboard } = require('grammy');

const {
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
    isResultFilename,
    paginateItems,
    shouldContinuePairingRefresh,
    validateTelegramConfig
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

    assert.equal(copyButton.text, '📋 Copy code');
    assert.deepEqual(copyButton.copy_text, { text: '581204' });
});

test('target buttons show friendly names and a single active target can be replaced', () => {
    const firstTarget = 'target_business_custom-list.txt';
    const secondTarget = 'target_personal_custom-list.txt';
    const selection = createActiveTargetSelection();

    assert.equal(getTargetDisplayName(firstTarget), 'business_custom-list');
    assert.equal(formatTargetButtonLabel(firstTarget, false), '◯ business_custom-list');
    assert.equal(formatTargetButtonLabel(firstTarget, true), '✅ business_custom-list');
    assert.equal(selection.get(), null);
    assert.equal(selection.select(firstTarget, [firstTarget, secondTarget]), firstTarget);
    assert.equal(selection.select(secondTarget, [firstTarget, secondTarget]), secondTarget);
    assert.equal(selection.get(), secondTarget);
    assert.equal(selection.reconcile([firstTarget]), null);
    assert.throws(() => selection.select(secondTarget, [firstTarget]), /not found/);
});

test('sender labels show connected, checking, and unavailable states clearly', () => {
    assert.equal(formatSenderButtonLabel('session_1', 'alive'), '🟢 session_1');
    assert.equal(formatSenderButtonLabel('session_2', 'scanning'), '🟢 session_2');
    assert.equal(formatSenderButtonLabel('session_3', 'checking'), '🟡 session_3');
    assert.equal(formatSenderButtonLabel('session_4', 'timeout/dead'), '⚪ session_4');
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
    assert.ok(labels.includes('⬆️ Upload Targets'));
    assert.ok(labels.includes('◯ business_one'));
    assert.ok(labels.includes('✅ personal_two'));
    assert.deepEqual(rows.find(row => row[0].text === '⬆️ Upload Targets').map(button => button.text), ['⬆️ Upload Targets']);
    assert.deepEqual(rows.find(row => row[0].text === '✅ personal_two').map(button => button.text), ['✅ personal_two']);
    assert.equal(labels.includes('📄 Targets'), false);
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
