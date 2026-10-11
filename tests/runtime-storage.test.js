const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRuntimePaths, migrateLegacyRuntimeData } = require('../core/runtime-storage');

const withTemporaryRoot = async (t, run) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cekbio-runtime-storage-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    await run(root);
};

test('migrates legacy runtime files into their dedicated folders without changing contents', async t => {
    await withTemporaryRoot(t, root => {
        fs.mkdirSync(path.join(root, 'session_1'));
        fs.writeFileSync(path.join(root, 'session_1', 'creds.json'), '{"key":"value"}');
        fs.writeFileSync(path.join(root, 'target list.txt'), '628123456789\n');
        fs.writeFileSync(path.join(root, 'result_personal_target list.txt'), 'result');
        fs.writeFileSync(path.join(root, 'target_personal_target list.json'), '[{"number":"628123456789"}]');
        fs.writeFileSync(path.join(root, 'checkpoint_target list.json'), '{"batchIndex":1}');
        fs.writeFileSync(path.join(root, 'log.txt'), 'sender log');
        fs.writeFileSync(path.join(root, 'a.log'), 'application log');

        const paths = migrateLegacyRuntimeData(root);

        assert.equal(fs.readFileSync(path.join(paths.sender('session_1'), 'creds.json'), 'utf8'), '{"key":"value"}');
        assert.equal(fs.readFileSync(paths.target('target list.txt'), 'utf8'), '628123456789\n');
        assert.equal(fs.readFileSync(paths.result('result_personal_target list.txt'), 'utf8'), 'result');
        assert.equal(fs.readFileSync(paths.resultDataFile('target_personal_target list.json'), 'utf8'),
            '[{"number":"628123456789"}]');
        assert.equal(fs.readFileSync(paths.checkpoint('checkpoint_target list.json'), 'utf8'), '{"batchIndex":1}');
        assert.equal(fs.readFileSync(paths.log('log.txt'), 'utf8'), 'sender log');
        assert.equal(fs.readFileSync(paths.log('a.log'), 'utf8'), 'application log');
        assert.equal(fs.existsSync(path.join(root, 'session_1')), false);
        assert.equal(fs.existsSync(path.join(root, 'target list.txt')), false);
        assert.equal(fs.existsSync(path.join(root, 'result_personal_target list.txt')), false);

        assert.doesNotThrow(() => migrateLegacyRuntimeData(root));
        assert.equal(fs.readFileSync(paths.target('target list.txt'), 'utf8'), '628123456789\n');
    });
});

test('stops the full migration before moving anything when a destination conflicts', async t => {
    await withTemporaryRoot(t, root => {
        const paths = createRuntimePaths(root);
        fs.mkdirSync(paths.targets);
        fs.writeFileSync(path.join(root, 'targets.txt'), 'legacy target');
        fs.writeFileSync(path.join(root, 'result_personal_targets.txt'), 'legacy result');
        fs.writeFileSync(paths.target('targets.txt'), 'existing destination');

        assert.throws(
            () => migrateLegacyRuntimeData(root),
            /No legacy files were moved[\s\S]*targets\.txt/
        );
        assert.equal(fs.readFileSync(path.join(root, 'targets.txt'), 'utf8'), 'legacy target');
        assert.equal(fs.readFileSync(paths.target('targets.txt'), 'utf8'), 'existing destination');
        assert.equal(fs.existsSync(paths.result('result_personal_targets.txt')), false);
        assert.equal(fs.readFileSync(path.join(root, 'result_personal_targets.txt'), 'utf8'), 'legacy result');
    });
});
