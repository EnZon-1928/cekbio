const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const { createLocalService } = require('../core/local-service');
const { createRuntimePaths } = require('../core/runtime-storage');
const { state } = require('../core/state');

const withTemporaryRoot = async (t, run) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cekbio-local-service-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    await run(root);
};

test('target name lookup avoids checkpoint data while full lookup retains it for scans', async t => {
    await withTemporaryRoot(t, root => {
        fs.writeFileSync(path.join(root, 'target_list.txt'), '628123456789\n');
        fs.writeFileSync(path.join(root, 'result_business_list.txt'), 'result');
        fs.writeFileSync(path.join(root, 'checkpoint_target_list.json'), '{"batchIndex":2}');
        const service = createLocalService({ root });

        assert.deepEqual(service.getTargetNames(), ['target_list.txt']);
        assert.deepEqual(service.getTargets(), {
            targets: ['target_list.txt'],
            checkpoints: { 'target_list.txt': { batchIndex: 2 } }
        });
    });
});

test('target uploads validate filenames, reject overwrites, and convert XLSX numbers', async t => {
    await withTemporaryRoot(t, root => {
        const service = createLocalService({ root });
        assert.throws(
            () => service.uploadTargetText({ name: '../targets.txt', contents: '123456' }),
            /valid \.txt filename/
        );
        assert.deepEqual(
            service.uploadTargetText({ name: 'targets.txt', contents: '123456\n' }),
            { target: 'targets.txt' }
        );
        assert.throws(
            () => service.uploadTargetText({ name: 'targets.txt', contents: '654321' }),
            /already exists/
        );

        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
            ['phone'],
            ['+628123456789'],
            [628987654321]
        ]), 'Contacts');
        const contents = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
        const result = service.uploadTargetWorkbook({ name: 'contacts.xlsx', contents });
        const paths = createRuntimePaths(root);

        assert.equal(result.target, 'contacts.txt');
        assert.equal(result.importedNumbers, 2);
        assert.equal(fs.readFileSync(paths.target('contacts.txt'), 'utf8'), '628123456789\n628987654321\n');
        assert.throws(
            () => service.uploadTargetWorkbook({ name: 'invalid.xlsx', contents: Buffer.from('not xlsx') }),
            /valid XLSX/
        );
    });
});

test('sender health checks are coalesced and cached for Telegram status views', async t => {
    await withTemporaryRoot(t, async root => {
        fs.mkdirSync(path.join(root, 'session_1'));
        let finishCheck;
        let checks = 0;
        const service = createLocalService({
            root,
            checkSender: () => {
                checks++;
                return new Promise(resolve => { finishCheck = resolve; });
            }
        });

        const first = service.getSenderHealth({ wait: true });
        const second = service.getSenderHealth({ wait: true });
        assert.equal(checks, 1);
        assert.deepEqual(await service.getSenderHealth({ probe: false }), {
            senders: [{ folder: 'session_1', status: 'checking', checkedAt: null }],
            checking: true
        });

        finishCheck({ status: 'alive' });
        const firstResult = await first;
        assert.equal(firstResult.senders[0].folder, 'session_1');
        assert.equal(firstResult.senders[0].status, 'alive');
        assert.equal(typeof firstResult.senders[0].checkedAt, 'number');
        assert.equal(firstResult.checking, false);
        assert.deepEqual(await second, firstResult);
    });
});

test('scan service passes the selected target and senders to the existing engine', async t => {
    await withTemporaryRoot(t, async root => {
        fs.writeFileSync(path.join(root, 'targets.txt'), '628123456789\n');
        fs.mkdirSync(path.join(root, 'session_1'));
        fs.mkdirSync(path.join(root, 'session_2'));
        state.isEngineRunning = false;
        let finishScan;
        let receivedOptions;
        const service = createLocalService({
            root,
            runEngine: (_returnToMenu, options) => {
                receivedOptions = options;
                state.isEngineRunning = true;
                return new Promise(resolve => { finishScan = resolve; });
            }
        });

        assert.deepEqual(service.startScan({
            targetFile: 'targets.txt',
            sessionFolders: ['session_1', 'session_2'],
            batchSize: 25,
            resume: false
        }), { status: 'starting' });
        assert.throws(
            () => service.deleteTarget('targets.txt', { confirm: true }),
            /while a scan is in progress/
        );

        await new Promise(resolve => setImmediate(resolve));
        assert.equal(receivedOptions.targetFile, 'targets.txt');
        assert.deepEqual(receivedOptions.sessionFolders, ['session_1', 'session_2']);
        assert.equal(receivedOptions.batchSize, 25);
        assert.equal(receivedOptions.resume, false);
        assert.equal(service.getStatus().scan.status, 'running');

        state.isEngineRunning = false;
        finishScan({ status: 'completed' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(service.getStatus().scan.status, 'completed');
        state.isEngineRunning = false;
    });
});

test('pause requests stay locked until checkpoint persistence and resume reuses saved scan options', async t => {
    await withTemporaryRoot(t, async root => {
        const paths = createRuntimePaths(root);
        fs.mkdirSync(paths.targets, { recursive: true });
        fs.mkdirSync(paths.sender('session_1'), { recursive: true });
        fs.writeFileSync(paths.target('targets.txt'), '10000001\n10000002\n');
        state.isEngineRunning = false;
        const engineRuns = [];
        const service = createLocalService({
            root,
            runEngine: (_returnToMenu, options) => {
                state.isEngineRunning = true;
                let finish;
                const promise = new Promise(resolve => { finish = resolve; });
                engineRuns.push({ options, finish });
                return promise;
            }
        });

        service.startScan({
            targetFile: 'targets.txt',
            sessionFolders: ['session_1'],
            batchSize: 1,
            resume: false
        });
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(service.pauseScan(), { status: 'pausing' });
        assert.deepEqual(service.pauseScan(), { status: 'pausing' });
        assert.equal(service.getStatus().scan.status, 'pausing');
        assert.equal(service.getStatus().scan.canPause, false);
        assert.throws(
            () => service.deleteTarget('targets.txt', { confirm: true }),
            /while a scan is in progress/
        );

        fs.writeFileSync(paths.checkpoint('checkpoint_targets.json'), JSON.stringify({
            batchIndex: 1,
            totalBatches: 2,
            multiSender: true,
            targetFile: 'targets.txt',
            batchSize: 1,
            completedBatchIndices: [0]
        }));
        state.isEngineRunning = false;
        engineRuns[0].finish({ status: 'paused' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(service.getStatus().scan.status, 'paused');
        assert.equal(service.getStatus().scan.canResume, true);

        assert.deepEqual(service.resumeScan(), { status: 'starting' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(engineRuns.length, 2);
        assert.equal(engineRuns[1].options.resume, true);
        assert.deepEqual(engineRuns[1].options.sessionFolders, ['session_1']);
        state.isEngineRunning = false;
        engineRuns[1].finish({ status: 'completed' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(service.getStatus().scan.status, 'completed');
        state.isEngineRunning = false;
    });
});

test('paused scan cannot resume when its target contents no longer match the checkpoint', async t => {
    await withTemporaryRoot(t, async root => {
        const paths = createRuntimePaths(root);
        fs.mkdirSync(paths.targets, { recursive: true });
        fs.mkdirSync(paths.sender('session_1'), { recursive: true });
        fs.writeFileSync(paths.target('targets.txt'), '10000001\n10000002\n');
        let finishScan;
        const service = createLocalService({
            root,
            runEngine: () => {
                state.isEngineRunning = true;
                return new Promise(resolve => { finishScan = resolve; });
            }
        });
        service.startScan({
            targetFile: 'targets.txt',
            sessionFolders: ['session_1'],
            batchSize: 1,
            resume: false
        });
        await new Promise(resolve => setImmediate(resolve));
        fs.writeFileSync(paths.checkpoint('checkpoint_targets.json'), JSON.stringify({
            batchIndex: 1,
            totalBatches: 2,
            targetHash: 'stale-hash',
            multiSender: true,
            targetFile: 'targets.txt',
            batchSize: 1,
            completedBatchIndices: [0]
        }));
        state.isEngineRunning = false;
        finishScan({ status: 'paused' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(service.getStatus().scan.canResume, false);
        assert.throws(() => service.resumeScan(), /checkpoint is unavailable or invalid/);
        state.isEngineRunning = false;
    });
});

test('result listing hides internal JSON and deletion requires explicit confirmation', async t => {
    await withTemporaryRoot(t, root => {
        fs.writeFileSync(path.join(root, 'target_business_targets.json'), '[]');
        fs.writeFileSync(path.join(root, 'result_business_targets.txt'), 'result');
        fs.writeFileSync(path.join(root, 'target_personal_targets.json'), '[{"number":"628123456789"}]');
        fs.writeFileSync(path.join(root, 'result_personal_targets.txt'), 'result');
        fs.writeFileSync(path.join(root, 'target_unregistered_targets.json'), '[{"number":"628123456780"}]');
        fs.writeFileSync(path.join(root, 'result_unregistered_targets.txt'), 'result');
        fs.writeFileSync(path.join(root, 'checkpoint_targets.json'), '{"batchIndex":1}');
        const service = createLocalService({ root });
        const paths = createRuntimePaths(root);

        assert.deepEqual(service.getResults(), {
            results: ['result_personal_targets.txt', 'result_unregistered_targets.txt']
        });
        assert.throws(
            () => service.deleteResult('result_personal_targets.txt'),
            /confirmation is required/
        );
        assert.deepEqual(
            service.deleteResult('result_personal_targets.txt', { confirm: true }),
            { deleted: 'result_personal_targets.txt', checkpointDeleted: true }
        );
        assert.equal(fs.existsSync(paths.checkpoint('checkpoint_targets.json')), false);
        assert.equal(fs.existsSync(paths.result('result_unregistered_targets.txt')), true);
        assert.deepEqual(service.getResults(), { results: ['result_unregistered_targets.txt'] });
        assert.throws(
            () => service.deleteResult('../result_unregistered_targets.txt', { confirm: true }),
            /not found/
        );
        assert.throws(
            () => service.getResultPath('../result_personal_targets.txt'),
            /not found/
        );
    });
});

test('result listing re-reads result files and internal findings from disk on every call', async t => {
    await withTemporaryRoot(t, root => {
        const service = createLocalService({ root });
        const paths = createRuntimePaths(root);
        assert.deepEqual(service.getResults(), { results: [] });

        fs.writeFileSync(paths.resultDataFile('target_personal_new.json'), '[{"number":"628123456789"}]');
        fs.writeFileSync(paths.result('result_personal_new.txt'), 'result');
        assert.deepEqual(service.getResults(), { results: ['result_personal_new.txt'] });

        fs.unlinkSync(paths.result('result_personal_new.txt'));
        assert.deepEqual(service.getResults(), { results: [] });
    });
});

test('sender deletion and application shutdown require confirmation', async t => {
    await withTemporaryRoot(t, async root => {
        fs.mkdirSync(path.join(root, 'session_1'));
        let shutdowns = 0;
        const service = createLocalService({ root, onShutdown: () => { shutdowns++; } });
        const paths = createRuntimePaths(root);

        await assert.rejects(
            service.deleteSender('session_1'),
            /confirmation is required/
        );
        await assert.rejects(
            service.requestShutdown(),
            /confirmation is required/
        );
        assert.deepEqual(
            await service.deleteSender('session_1', { confirm: true }),
            { deleted: 'session_1' }
        );
        assert.equal(fs.existsSync(paths.sender('session_1')), false);
        assert.deepEqual(
            await service.requestShutdown({ confirm: true }),
            { message: 'Application is shutting down.' }
        );
        assert.equal(shutdowns, 1);
    });
});

test('update requires confirmation and prevents new operations until it finishes', async t => {
    await withTemporaryRoot(t, async root => {
        fs.writeFileSync(path.join(root, 'targets.txt'), '628123456789\n');
        fs.mkdirSync(path.join(root, 'session_1'));
        let finishUpdate;
        let restarts = 0;
        const service = createLocalService({
            root,
            updateManager: {
                checkForUpdates: async () => ({ updateAvailable: true, commitsBehind: 1 }),
                applyUpdate: () => new Promise(resolve => { finishUpdate = resolve; })
            },
            onRestart: async () => { restarts++; }
        });
        await assert.rejects(service.applyUpdate(), /confirmation is required/);
        const applying = service.applyUpdate({ confirm: true });
        await new Promise(resolve => setImmediate(resolve));

        assert.throws(
            () => service.startScan({
                targetFile: 'targets.txt',
                sessionFolders: ['session_1'],
                batchSize: 10,
                resume: false
            }),
            /Another sender or scan operation is already running/
        );
        assert.throws(
            () => service.uploadTargetText({ name: 'new.txt', contents: '628123456789' }),
            /while an update is running/
        );

        finishUpdate({ updated: true });
        assert.deepEqual(await applying, { updated: true });
        assert.equal(restarts, 0);
        assert.throws(
            () => service.startScan({
                targetFile: 'targets.txt',
                sessionFolders: ['session_1'],
                batchSize: 10,
                resume: false
            }),
            /Another sender or scan operation is already running/
        );
        assert.throws(
            () => service.uploadTargetText({ name: 'later.txt', contents: '628123456789' }),
            /while an update is running/
        );
        await service.restartApplication();
        assert.equal(restarts, 1);
    });
});

test('update availability reads cached state and refreshes without blocking operations', async t => {
    await withTemporaryRoot(t, async root => {
        let checks = 0;
        const cachedHint = { updateAvailable: true, checkedAt: Date.now() };
        const service = createLocalService({
            root,
            updateManager: {
                checkForUpdates: async () => ({ updateAvailable: true }),
                applyUpdate: async () => ({ updated: false }),
                getCachedUpdateHint: () => cachedHint,
                refreshUpdateHint: async () => {
                    checks++;
                    return cachedHint;
                }
            }
        });

        assert.equal(service.getUpdateAvailability(), true);
        assert.deepEqual(await service.refreshUpdateHint(), cachedHint);
        assert.equal(checks, 1);

        const previousEngineState = state.isEngineRunning;
        state.isEngineRunning = true;
        try {
            assert.deepEqual(await service.refreshUpdateHint(), cachedHint);
            assert.equal(checks, 1);
        } finally {
            state.isEngineRunning = previousEngineState;
        }
    });
});
