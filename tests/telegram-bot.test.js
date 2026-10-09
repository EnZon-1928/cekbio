const test = require('node:test');
const assert = require('node:assert/strict');
const { InlineKeyboard } = require('grammy');

const {
    addPairingCodeCopyButton,
    createActionRegistry,
    createActiveTargetSelection,
    formatTargetButtonLabel,
    getTargetDisplayName,
    isAuthorizedUpdate,
    isResultFilename,
    paginateItems,
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
