const test = require('node:test');
const assert = require('node:assert/strict');

const {
    isAuthorizedUpdate,
    isResultFilename,
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
