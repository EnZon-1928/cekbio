const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const { state } = require('./state');
const { startEngine } = require('./engine');
const { addSender, pingSender } = require('./sender');
const { subscribeLogs } = require('../utils/logger');

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_WORKSHEET_CELLS = 1_000_000;
const SESSION_PATTERN = /^session_[^/\\\u0000-\u001f]+$/;
const RESULT_PATTERN = /^result_(business|personal|unregistered)_(.+)\.txt$/;

const createError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

const listSendersIn = root => fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => SESSION_PATTERN.test(entry.name) && entry.isDirectory())
    .map(entry => entry.name)
    .sort((a, b) => {
        const aId = Number(a.slice(8));
        const bId = Number(b.slice(8));
        return Number.isFinite(aId) && Number.isFinite(bId) ? aId - bId : a.localeCompare(b);
    });

const listTargetsIn = root => fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.txt')
        && !entry.name.includes('report_') && !entry.name.includes('result_'))
    .map(entry => entry.name)
    .sort();

const validateTargetFilename = filename => typeof filename === 'string'
    && path.basename(filename) === filename
    && !filename.includes('/') && !filename.includes('\\')
    && !/[\u0000-\u001f\u007f]/.test(filename)
    && filename.length > 4 && filename.endsWith('.txt')
    && !filename.includes('report_') && !filename.includes('result_');

const numbersFromWorkbook = buffer => {
    let workbook;
    try {
        workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellNF: true });
    } catch {
        throw createError('The XLSX workbook is invalid or cannot be read.');
    }

    const numbers = [];
    let visitedCells = 0;
    for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        if (!sheet?.['!ref']) continue;

        let range;
        try {
            range = XLSX.utils.decode_range(sheet['!ref']);
        } catch {
            throw createError('The XLSX workbook contains an invalid worksheet range.');
        }
        const cellCount = (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1);
        visitedCells += cellCount;
        if (!Number.isSafeInteger(cellCount) || visitedCells > MAX_WORKSHEET_CELLS) {
            throw createError('The XLSX workbook contains too many cells to process safely.', 413);
        }

        for (let row = range.s.r; row <= range.e.r; row++) {
            for (let column = range.s.c; column <= range.e.c; column++) {
                const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
                if (!cell || cell.t === 'b' || cell.t === 'e' || cell.t === 'd' || cell.v == null) continue;
                if (typeof cell.v !== 'string' && typeof cell.v !== 'number') continue;
                if (typeof cell.v === 'number' && cell.v < 0) continue;
                if (typeof cell.v === 'number' && !Number.isSafeInteger(cell.v)) continue;
                if (typeof cell.v === 'number' && XLSX.SSF.is_date(cell.z)) continue;

                let digits;
                if (typeof cell.v === 'number') {
                    digits = String(cell.v);
                    const displayed = String(cell.w || '');
                    if (!/[eE][+-]?\d+$/.test(displayed)) {
                        const displayedDigits = displayed.replace(/\D/g, '');
                        if (displayedDigits.length > 5) digits = displayedDigits;
                    }
                } else {
                    if (/^[+-]?(?:\d+\.?\d*|\.\d+)[eE][+-]?\d+$/.test(cell.v.trim())) continue;
                    digits = cell.v.replace(/\D/g, '');
                }
                if (digits.length > 5) numbers.push(digits);
            }
        }
    }
    return numbers;
};

const createLocalService = ({
    root = process.cwd(),
    runEngine = startEngine,
    createSender = addSender,
    checkSender = pingSender,
    onShutdown = () => {}
} = {}) => {
    let scanJob = null;
    let senderJob = null;
    let senderHealthPromise = null;
    let scanLogSubscription = null;
    const senderHealth = new Map();

    const operationIsRunning = () => scanJob?.status === 'starting' || scanJob?.status === 'running'
        || senderJob?.status === 'starting' || senderJob?.status === 'running';
    const scanIsRunning = () => scanJob?.status === 'starting' || scanJob?.status === 'running'
        || state.isEngineRunning;
    const listSenders = () => listSendersIn(root);
    const listTargets = () => listTargetsIn(root);
    const resolveInRoot = filename => path.resolve(root, filename);

    const hasResultData = filename => {
        const match = filename.match(RESULT_PATTERN);
        if (!match) return false;
        const [, category, targetName] = match;
        const dataPath = resolveInRoot(`target_${category}_${targetName}.json`);
        if (!fs.existsSync(dataPath)) return false;
        const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
        if (!Array.isArray(data)) throw new Error(`Internal result data is invalid for ${filename}.`);
        return data.length > 0;
    };

    const listResults = () => fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isFile() && RESULT_PATTERN.test(entry.name) && hasResultData(entry.name))
        .map(entry => entry.name)
        .sort();

    const getTargets = () => {
        const targets = listTargets();
        const checkpoints = {};
        for (const target of targets) {
            const checkpointPath = resolveInRoot(`checkpoint_${target.replace('.txt', '')}.json`);
            if (fs.existsSync(checkpointPath)) {
                try {
                    checkpoints[target] = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
                } catch {
                    checkpoints[target] = { invalid: true };
                }
            }
        }
        return { targets, checkpoints };
    };

    const getSenderHealth = async ({ probe = true, wait = false } = {}) => {
        const senders = listSenders();
        for (const folder of senderHealth.keys()) {
            if (!senders.includes(folder)) senderHealth.delete(folder);
        }

        if (probe && !senderHealthPromise && !operationIsRunning() && !state.isEngineRunning) {
            for (const folder of senders) {
                senderHealth.set(folder, { status: 'checking', checkedAt: null });
            }
            senderHealthPromise = Promise.all(senders.map(async folder => {
                try {
                    const result = await checkSender(folder);
                    senderHealth.set(folder, { status: result.status, checkedAt: Date.now() });
                } catch (error) {
                    senderHealth.set(folder, {
                        status: 'error',
                        error: error.message,
                        checkedAt: Date.now()
                    });
                }
            })).finally(() => {
                senderHealthPromise = null;
            });
            senderHealthPromise.catch(error => {
                console.error('Automatic sender health check failed:', error.message);
            });
        }

        if (wait && senderHealthPromise) await senderHealthPromise;
        return {
            senders: listSenders().map(folder => ({
                folder,
                ...(senderHealth.get(folder) || { status: 'unknown', checkedAt: null })
            })),
            checking: Boolean(senderHealthPromise)
        };
    };

    const getStatus = () => {
        const scanStatus = scanJob?.status === 'starting' && state.isEngineRunning
            ? 'running'
            : scanJob?.status;
        const scanStateReady = !(scanStatus === 'starting' && !state.isEngineRunning);
        const batches = scanStateReady ? state.batches : [];
        const totalBatches = batches.length;
        const currentBatch = scanStatus === 'completed'
            ? totalBatches
            : Math.min(state.batchIndex + (state.isEngineRunning ? 1 : 0), totalBatches);
        const totalTargets = batches.reduce((total, batch) => total + batch.length, 0);
        const completedTargets = scanStatus === 'completed'
            ? totalTargets
            : batches
                .slice(0, Math.min(state.batchIndex, totalBatches))
                .reduce((total, batch) => total + batch.length, 0);

        return {
            scan: scanJob ? {
                status: scanStatus,
                targetFile: scanJob.targetFile,
                sessionFolder: scanJob.sessionFolder,
                sessionFolders: scanJob.sessionFolders,
                senderStatuses: scanJob.senderStatuses,
                activeBatchProgress: Object.entries(scanStateReady ? state.workerProgress || {} : {})
                    .map(([folder, progress]) => ({ folder, ...progress })),
                error: scanJob.error,
                logs: scanJob.logs,
                currentBatch: scanJob.sessionFolders
                    ? (scanStatus === 'completed' ? totalBatches : state.completedBatchIndices.length)
                    : currentBatch,
                totalBatches,
                completedBatches: scanJob.sessionFolders
                    ? (scanStatus === 'completed' ? totalBatches : state.completedBatchIndices.length)
                    : currentBatch,
                completedTargets: scanJob.sessionFolders && scanStatus !== 'completed'
                    ? (scanStateReady ? state.completedBatchIndices : []).reduce(
                        (total, index) => total + (batches[index]?.length || 0),
                        0
                    )
                    : completedTargets,
                totalTargets,
                statistics: state.statistics
            } : null,
            sender: senderJob
        };
    };

    const uploadTargetText = ({ name, contents }) => {
        if (typeof name !== 'string' || typeof contents !== 'string'
            || Buffer.byteLength(contents, 'utf8') > MAX_UPLOAD_BYTES) {
            throw createError('Choose a .txt file no larger than 10 MB.');
        }
        if (!validateTargetFilename(name)) {
            throw createError('Target filename must be a valid .txt filename and cannot contain report_ or result_.');
        }
        const targetPath = resolveInRoot(name);
        try {
            fs.writeFileSync(targetPath, contents, { flag: 'wx' });
        } catch (error) {
            if (error.code === 'EEXIST') throw createError('A file with that name already exists.', 409);
            throw error;
        }
        return { target: name };
    };

    const uploadTargetWorkbook = ({ name, contents }) => {
        if (typeof name !== 'string' || !/\.xlsx$/i.test(name)
            || !Buffer.isBuffer(contents) || contents.length === 0) {
            throw createError('Choose a valid .xlsx workbook no larger than 10 MB.');
        }
        if (contents.length > MAX_UPLOAD_BYTES) {
            throw createError('The XLSX file must be no larger than 10 MB.', 413);
        }
        if (contents[0] !== 0x50 || contents[1] !== 0x4b
            || contents[2] !== 0x03 || contents[3] !== 0x04) {
            throw createError('The selected file is not a valid XLSX workbook.');
        }
        const sourceName = path.basename(name);
        const targetName = `${sourceName.slice(0, -5)}.txt`;
        if (sourceName !== name || !validateTargetFilename(targetName)) {
            throw createError('The workbook filename cannot be used as a target list name.');
        }
        const numbers = numbersFromWorkbook(contents);
        if (numbers.length === 0) {
            throw createError('No phone numbers were found. Enter numbers as text or as whole-number cells with at least six digits.', 422);
        }
        try {
            fs.writeFileSync(resolveInRoot(targetName), `${numbers.join('\n')}\n`, { flag: 'wx' });
        } catch (error) {
            if (error.code === 'EEXIST') {
                throw createError(`A target list named "${targetName}" already exists.`, 409);
            }
            throw error;
        }
        return {
            target: targetName,
            importedNumbers: numbers.length,
            message: `Imported ${numbers.length.toLocaleString()} numbers from all worksheets into ${targetName}.`
        };
    };

    const deleteTarget = (filename, { confirm } = {}) => {
        if (scanIsRunning()) {
            throw createError('Target lists cannot be removed while a scan is in progress.', 409);
        }
        if (confirm !== true) throw createError('Explicit confirmation is required to remove a target list.');
        if (!listTargets().includes(filename)) throw createError('Target list not found.', 404);
        fs.unlinkSync(resolveInRoot(filename));
        const checkpointPath = resolveInRoot(`checkpoint_${filename.replace('.txt', '')}.json`);
        const checkpointDeleted = fs.existsSync(checkpointPath);
        if (checkpointDeleted) fs.unlinkSync(checkpointPath);
        return { deleted: filename, checkpointDeleted };
    };

    const deleteResult = (filename, { confirm } = {}) => {
        if (scanIsRunning()) {
            throw createError('Results cannot be removed while a scan is in progress.', 409);
        }
        if (confirm !== true) throw createError('Explicit confirmation is required to remove a result.');
        if (!RESULT_PATTERN.test(filename) || !listResults().includes(filename)) {
            throw createError('Result not found.', 404);
        }
        fs.unlinkSync(resolveInRoot(filename));
        return { deleted: filename };
    };

    const deleteSender = async (folder, { confirm } = {}) => {
        if (confirm !== true) throw createError('Explicit confirmation is required to delete a sender session.');
        if (!listSenders().includes(folder)) throw createError('Sender session not found.', 404);
        if (operationIsRunning() || state.isEngineRunning) {
            throw createError('Cannot delete a sender while another operation is running.', 409);
        }
        senderJob = { status: 'running', mode: 'delete', sessionFolder: folder, error: null };
        try {
            if (senderHealthPromise) await senderHealthPromise;
            if (scanJob?.status === 'starting' || scanJob?.status === 'running' || state.isEngineRunning) {
                throw createError('Cannot delete a sender while a scan is running.', 409);
            }
            if (!listSenders().includes(folder)) throw createError('Sender session not found.', 404);
            fs.rmSync(resolveInRoot(folder), { recursive: true });
            senderHealth.delete(folder);
            senderJob.status = 'completed';
            return { deleted: folder };
        } catch (error) {
            senderJob.status = 'failed';
            senderJob.error = error.message;
            throw error;
        }
    };

    const startSender = ({ phoneNumber }) => {
        if (operationIsRunning() || state.isEngineRunning) {
            throw createError('Another sender or scan operation is already running.', 409);
        }
        if (typeof phoneNumber !== 'string' || phoneNumber.replace(/\D/g, '').length < 6) {
            throw createError('Enter a valid sender number.');
        }
        senderJob = { status: 'running', pairingCode: null, sessionFolder: null, error: null };
        createSender({
            phoneNumber,
            onPairingCode: (code, folder) => {
                senderJob.pairingCode = code;
                senderJob.sessionFolder = folder;
            }
        }).then(result => {
            senderJob.status = result?.status || 'failed';
            senderJob.sessionFolder = result?.folder || senderJob.sessionFolder;
        }).catch(error => {
            senderJob.status = 'failed';
            senderJob.error = error.message;
        });
        return { status: 'running' };
    };

    const startScan = ({ targetFile, sessionFolders, sessionFolder, batchSize, resume }) => {
        if (operationIsRunning() || state.isEngineRunning) {
            throw createError('Another sender or scan operation is already running.', 409);
        }
        const availableSenders = listSenders();
        const multiSender = Array.isArray(sessionFolders);
        const selectedSenders = multiSender ? [...new Set(sessionFolders)] : [sessionFolder];
        if (typeof targetFile !== 'string' || !listTargets().includes(targetFile)
            || selectedSenders.length === 0
            || selectedSenders.some(folder => typeof folder !== 'string' || !availableSenders.includes(folder))
            || !Number.isSafeInteger(batchSize) || batchSize < 1
            || typeof resume !== 'boolean') {
            throw createError('Select a target and sender session, enter a positive batch size, and choose checkpoint behavior.');
        }

        scanJob = {
            status: 'starting',
            targetFile,
            sessionFolder: multiSender ? null : sessionFolder,
            sessionFolders: multiSender ? selectedSenders : null,
            senderStatuses: multiSender
                ? Object.fromEntries(selectedSenders.map(folder => [folder, { status: 'checking' }]))
                : null,
            error: null,
            logs: []
        };
        scanLogSubscription?.();
        scanLogSubscription = subscribeLogs(entry => {
            if (!scanJob || !['starting', 'running'].includes(scanJob.status)) return;
            scanJob.logs.push(entry);
            if (scanJob.logs.length > 300) scanJob.logs.shift();
        });
        const stopRecordingLogs = () => {
            scanLogSubscription?.();
            scanLogSubscription = null;
        };
        const pendingHealthCheck = senderHealthPromise;
        Promise.resolve(pendingHealthCheck).then(() => runEngine(null, {
            targetFile,
            ...(multiSender ? {
                sessionFolders: selectedSenders,
                onWorkerStatus: (folder, status, error) => {
                    const senderStatus = { status };
                    if (error) senderStatus.error = error;
                    scanJob.senderStatuses[folder] = senderStatus;
                    senderHealth.set(folder, { ...senderStatus, checkedAt: Date.now() });
                }
            } : { sessionFolder }),
            batchSize,
            resume
        })).then(result => {
            scanJob.status = result?.status || 'completed';
            stopRecordingLogs();
        }).catch(error => {
            scanJob.status = 'failed';
            scanJob.error = error.message;
            stopRecordingLogs();
        });
        return { status: 'starting' };
    };

    const requestShutdown = async ({ confirm } = {}) => {
        if (confirm !== true) throw createError('Explicit confirmation is required to shut down the application.');
        if (operationIsRunning() || state.isEngineRunning) {
            throw createError('The application cannot shut down while a scan or sender operation is in progress.', 409);
        }
        senderJob = { status: 'running', mode: 'shutdown', error: null };
        if (senderHealthPromise) await senderHealthPromise;
        senderJob.status = 'completed';
        await onShutdown();
        return { message: 'Application is shutting down.' };
    };

    return {
        deleteResult,
        deleteSender,
        deleteTarget,
        getResultPath(filename) {
            if (!RESULT_PATTERN.test(filename) || !listResults().includes(filename)) {
                throw createError('Result not found.', 404);
            }
            return resolveInRoot(filename);
        },
        getResults: () => ({ results: listResults() }),
        getSenderHealth,
        getSenders: () => ({ senders: listSenders() }),
        getStatus,
        getTargets,
        requestShutdown,
        startScan,
        startSender,
        uploadTargetText,
        uploadTargetWorkbook
    };
};

module.exports = { createLocalService };
