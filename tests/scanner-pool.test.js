const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { state } = require('../core/state');
const { runScannerPool } = require('../core/scanner');

const resetScanState = batches => Object.assign(state, {
    isEngineRunning: true,
    activeTargetFile: '',
    batchIndex: 0,
    batches,
    multiSenderScan: true,
    completedBatchIndices: [],
    scanBatchSize: batches[0]?.length || null,
    targetBusiness: [],
    targetPersonal: [],
    targetUnregistered: [],
    statistics: { registered: 0, unregistered: 0, bioBusiness: 0, noBioBusiness: 0, personal: 0 }
});

const makeWorker = (folder, onWhatsApp) => {
    const listeners = new Set();
    const worker = {
        folder,
        available: true,
        sock: { onWhatsApp },
        watchFailure() {
            let notify;
            const promise = new Promise(resolve => { notify = resolve; });
            if (worker.available) listeners.add(notify);
            else notify({ error: new Error('sender disconnected') });
            return { promise, cancel: () => listeners.delete(notify) };
        },
        disconnect(error = new Error('sender disconnected')) {
            worker.available = false;
            for (const notify of listeners) notify({ error });
            listeners.clear();
        },
        close(error) {
            worker.disconnect(error);
        }
    };
    return worker;
};

const registeredResults = (...jids) => jids.map(jid => ({ jid, exists: false }));

test('sender pool scans batches concurrently and combines their results', async () => {
    resetScanState([['10000001'], ['10000002'], ['10000003'], ['10000004']]);
    let active = 0;
    let maximumActive = 0;
    const makeSocket = delayMs => async (...jids) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        active--;
        return registeredResults(...jids);
    };

    const result = await runScannerPool([
        makeWorker('session_1', makeSocket(20)),
        makeWorker('session_2', makeSocket(1))
    ], { persist() {} });

    assert.equal(result.status, 'completed');
    assert.equal(result.completedBatches, 4);
    assert.ok(maximumActive > 1);
    assert.deepEqual(
        state.targetUnregistered.map(target => target.number),
        ['+10000001', '+10000002', '+10000003', '+10000004']
    );
    assert.equal(state.statistics.unregistered, 4);
});

test('failed batch is retried on a healthy sender without committing partial results', async () => {
    resetScanState([['10000001'], ['10000002']]);
    let shouldFail = true;
    const failingWorker = makeWorker('session_1', async (...jids) => {
        if (shouldFail) {
            shouldFail = false;
            throw new Error('simulated connection failure');
        }
        return registeredResults(...jids);
    });
    const healthyWorker = makeWorker('session_2', async (...jids) => registeredResults(...jids));

    const result = await runScannerPool([failingWorker, healthyWorker], { persist() {} });

    assert.equal(result.status, 'completed');
    assert.equal(state.targetUnregistered.length, 2);
    assert.equal(new Set(state.targetUnregistered.map(target => target.number)).size, 2);
    assert.equal(state.statistics.unregistered, 2);
});

test('sender disconnect during an in-flight batch lets another worker retry it', async () => {
    resetScanState([['10000001'], ['10000002']]);
    let brokenWorker;
    brokenWorker = makeWorker('session_1', (...jids) => new Promise((resolve, reject) => {
        setTimeout(() => {
            const error = new Error('socket closed mid-batch');
            brokenWorker.disconnect(error);
            reject(error);
        }, 10);
    }));
    const healthyWorker = makeWorker('session_2', async (...jids) => registeredResults(...jids));

    const result = await runScannerPool([brokenWorker, healthyWorker], { persist() {} });

    assert.equal(result.status, 'completed');
    assert.equal(state.targetUnregistered.length, 2);
    assert.equal(new Set(state.targetUnregistered.map(target => target.number)).size, 2);
});

test('pool pauses with completed batch indexes and resumes without rescanning committed batches', async () => {
    const originalDirectory = process.cwd();
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cekbio-scanner-pool-'));
    process.chdir(temporaryDirectory);
    resetScanState([['10000001'], ['10000002'], ['10000003']]);
    state.activeTargetFile = 'targets.txt';
    let calls = 0;
    const interruptedWorker = makeWorker('session_1', async (...jids) => {
        calls++;
        if (calls === 2) throw new Error('sender disconnected');
        return registeredResults(...jids);
    });

    try {
        const paused = await runScannerPool([interruptedWorker]);
        assert.equal(paused.status, 'paused');
        assert.deepEqual(state.completedBatchIndices, [0]);
        assert.equal(state.targetUnregistered.length, 1);
        assert.deepEqual(JSON.parse(fs.readFileSync('checkpoint_targets.json', 'utf8')), {
            batchIndex: 1,
            totalBatches: 3,
            multiSender: true,
            targetFile: 'targets.txt',
            batchSize: 1,
            completedBatchIndices: [0]
        });

        let resumeCalls = 0;
        const resumed = await runScannerPool([
            makeWorker('session_2', async (...jids) => {
                resumeCalls++;
                return registeredResults(...jids);
            })
        ]);

        assert.equal(resumed.status, 'completed');
        assert.equal(resumeCalls, 2);
        assert.equal(state.targetUnregistered.length, 3);
        assert.equal(state.statistics.unregistered, 3);
        assert.deepEqual(state.completedBatchIndices, []);
        assert.equal(fs.existsSync('checkpoint_targets.json'), false);
    } finally {
        process.chdir(originalDirectory);
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
});
