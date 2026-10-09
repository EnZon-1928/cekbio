const http = require('http');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const { state } = require('../core/state');
const { startEngine } = require('../core/engine');
const { addSender, pingSender } = require('../core/sender');
const { subscribeLogs } = require('../utils/logger');

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_BASE64_LENGTH = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4;
const MAX_JSON_UPLOAD_BYTES = MAX_UPLOAD_BASE64_LENGTH + 16 * 1024;
const MAX_WORKSHEET_CELLS = 1_000_000;
const SESSION_PATTERN = /^session_[^/\\\u0000-\u001f]+$/;
const RESULT_PATTERN = /^result_(business|personal|unregistered)_(.+)\.txt$/;

let scanJob = null;
let senderJob = null;
let senderHealthPromise = null;
const senderHealth = new Map();

const sendJson = (res, status, value) => {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
    });
    res.end(JSON.stringify(value));
};

const readJsonBody = async (req, limit = 64 * 1024) => {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > limit) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 });
        chunks.push(chunk);
    }

    let value;
    try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 });
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw Object.assign(new Error('Request body must be a JSON object.'), { statusCode: 400 });
    }
    return value;
};

const listSenders = () => fs.readdirSync(process.cwd(), { withFileTypes: true })
    .filter(entry => SESSION_PATTERN.test(entry.name) && entry.isDirectory())
    .map(entry => entry.name)
    .sort((a, b) => {
        const aId = Number(a.slice(8));
        const bId = Number(b.slice(8));
        return Number.isFinite(aId) && Number.isFinite(bId) ? aId - bId : a.localeCompare(b);
    });

const listTargets = () => fs.readdirSync(process.cwd(), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.txt')
        && !entry.name.includes('report_') && !entry.name.includes('result_'))
    .map(entry => entry.name)
    .sort();

const hasResultData = filename => {
    const match = filename.match(RESULT_PATTERN);
    if (!match) return false;
    const [, category, targetName] = match;
    const dataPath = path.join(process.cwd(), `target_${category}_${targetName}.json`);
    if (!fs.existsSync(dataPath)) return false;
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    if (!Array.isArray(data)) throw new Error(`Internal result data is invalid for ${filename}.`);
    return data.length > 0;
};

const listResults = () => fs.readdirSync(process.cwd(), { withFileTypes: true })
    .filter(entry => entry.isFile() && RESULT_PATTERN.test(entry.name) && hasResultData(entry.name))
    .map(entry => entry.name)
    .sort();

const validateTargetFilename = filename => typeof filename === 'string'
    && path.basename(filename) === filename
    && !filename.includes('/') && !filename.includes('\\')
    && !/[\u0000-\u001f\u007f]/.test(filename)
    && filename.length > 4 && filename.endsWith('.txt')
    && !filename.includes('report_') && !filename.includes('result_');

const numbersFromWorkbook = (buffer) => {
    let workbook;
    try {
        workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellNF: true });
    } catch {
        throw Object.assign(new Error('The XLSX workbook is invalid or cannot be read.'), { statusCode: 400 });
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
            throw Object.assign(new Error('The XLSX workbook contains an invalid worksheet range.'), { statusCode: 400 });
        }
        const cellCount = (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1);
        visitedCells += cellCount;
        if (!Number.isSafeInteger(cellCount) || visitedCells > MAX_WORKSHEET_CELLS) {
            throw Object.assign(new Error('The XLSX workbook contains too many cells to process safely.'), { statusCode: 413 });
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

const operationIsRunning = () => scanJob?.status === 'starting' || scanJob?.status === 'running'
    || senderJob?.status === 'starting' || senderJob?.status === 'running';

const getSenderHealth = ({ probe = true } = {}) => {
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
                const result = await pingSender(folder);
                senderHealth.set(folder, { status: result.status, checkedAt: Date.now() });
            } catch (error) {
                senderHealth.set(folder, { status: 'error', error: error.message, checkedAt: Date.now() });
            }
        })).finally(() => {
            senderHealthPromise = null;
        });
        senderHealthPromise.catch(error => {
            console.error('Automatic sender health check failed:', error.message);
        });
    }

    return {
        senders: senders.map(folder => ({
            folder,
            ...(senderHealth.get(folder) || { status: 'unknown', checkedAt: null })
        })),
        checking: Boolean(senderHealthPromise)
    };
};

const logToJob = (entry) => {
    if (!scanJob || !['starting', 'running'].includes(scanJob.status)) return;
    scanJob.logs.push(entry);
    if (scanJob.logs.length > 300) scanJob.logs.shift();
};

subscribeLogs(logToJob);

const validateRequestOrigin = (req) => {
    const host = req.headers.host;
    if (!host || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return false;
    if (!req.headers.origin) return true;

    try {
        const origin = new URL(req.headers.origin);
        return origin.protocol === 'http:' && origin.host === host
            && (origin.hostname === '127.0.0.1' || origin.hostname === 'localhost');
    } catch {
        return false;
    }
};

const setSecurityHeaders = (res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
};

const routeRequest = async (req, res, server) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let pathname;
    try {
        pathname = decodeURIComponent(url.pathname);
    } catch {
        throw Object.assign(new Error('Invalid URL path.'), { statusCode: 400 });
    }
    const method = req.method;

    if (method === 'GET' && pathname === '/') {
        const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
        return;
    }
    if (method === 'GET' && ['/app.js', '/style.css'].includes(pathname)) {
        const filename = pathname.slice(1);
        const type = filename.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8';
        const content = fs.readFileSync(path.join(__dirname, 'public', filename));
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
        res.end(content);
        return;
    }

    if (method === 'GET' && pathname === '/api/status') {
        const totalBatches = state.batches.length;
        const scanStatus = scanJob?.status === 'starting' && state.isEngineRunning
            ? 'running'
            : scanJob?.status;
        const currentBatch = scanStatus === 'completed'
            ? totalBatches
            : Math.min(state.batchIndex + (state.isEngineRunning ? 1 : 0), totalBatches);
        const totalTargets = state.batches.reduce((total, batch) => total + batch.length, 0);
        const completedTargets = scanStatus === 'completed'
            ? totalTargets
            : state.batches
                .slice(0, Math.min(state.batchIndex, totalBatches))
                .reduce((total, batch) => total + batch.length, 0);
        sendJson(res, 200, {
            scan: scanJob ? {
                status: scanStatus,
                targetFile: scanJob.targetFile,
                sessionFolder: scanJob.sessionFolder,
                sessionFolders: scanJob.sessionFolders,
                senderStatuses: scanJob.senderStatuses,
                error: scanJob.error,
                logs: scanJob.logs,
                currentBatch: scanJob.sessionFolders
                    ? (scanStatus === 'completed' ? totalBatches : state.completedBatchIndices.length)
                    : currentBatch,
                totalBatches,
                completedTargets: scanJob.sessionFolders && scanStatus !== 'completed'
                    ? state.completedBatchIndices.reduce(
                        (total, index) => total + (state.batches[index]?.length || 0),
                        0
                    )
                    : completedTargets,
                totalTargets,
                statistics: state.statistics
            } : null,
            sender: senderJob
        });
        return;
    }

    if (method === 'GET' && pathname === '/api/senders') {
        sendJson(res, 200, { senders: listSenders() });
        return;
    }
    if (method === 'GET' && pathname === '/api/senders/health') {
        const refresh = url.searchParams.get('refresh') !== '0';
        if (url.searchParams.get('wait') === '1' && senderHealthPromise) {
            await senderHealthPromise;
        }
        sendJson(res, 200, getSenderHealth({ probe: refresh }));
        return;
    }
    if (method === 'GET' && pathname === '/api/targets') {
        const targets = listTargets();
        const checkpoints = {};
        for (const target of targets) {
            const checkpointPath = path.join(process.cwd(), `checkpoint_${target.replace('.txt', '')}.json`);
            if (fs.existsSync(checkpointPath)) {
                try {
                    checkpoints[target] = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
                } catch {
                    checkpoints[target] = { invalid: true };
                }
            }
        }
        sendJson(res, 200, { targets, checkpoints });
        return;
    }
    if (method === 'GET' && pathname === '/api/results') {
        sendJson(res, 200, { results: listResults() });
        return;
    }
    if (method === 'GET' && pathname.startsWith('/api/results/')) {
        const filename = pathname.slice('/api/results/'.length);
        if (!RESULT_PATTERN.test(filename) || !listResults().includes(filename)) {
            sendJson(res, 404, { error: 'Result not found.' });
            return;
        }
        res.writeHead(200, {
            'content-type': filename.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
            'content-disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(filename).replace(/'/g, '%27')}`,
            'x-content-type-options': 'nosniff'
        });
        fs.createReadStream(path.join(process.cwd(), filename)).pipe(res);
        return;
    }
    if (method === 'POST' && pathname.startsWith('/api/results/') && pathname.endsWith('/delete')) {
        if (scanJob?.status === 'starting' || scanJob?.status === 'running') {
            sendJson(res, 409, { error: 'Results cannot be removed while a scan is in progress.' });
            return;
        }
        const filename = pathname.slice('/api/results/'.length, -'/delete'.length);
        const body = await readJsonBody(req);
        if (body.confirm !== true) {
            sendJson(res, 400, { error: 'Explicit confirmation is required to remove a result.' });
            return;
        }
        if (!RESULT_PATTERN.test(filename) || !listResults().includes(filename)) {
            sendJson(res, 404, { error: 'Result not found.' });
            return;
        }
        fs.unlinkSync(path.join(process.cwd(), filename));
        sendJson(res, 200, { deleted: filename });
        return;
    }

    if (method === 'POST' && pathname === '/api/targets/xlsx') {
        const body = await readJsonBody(req, MAX_JSON_UPLOAD_BYTES);
        if (typeof body.name !== 'string' || !/\.xlsx$/i.test(body.name)
            || typeof body.contentsBase64 !== 'string'
            || body.contentsBase64.length === 0
            || body.contentsBase64.length % 4 !== 0
            || /[^A-Za-z0-9+/=]/.test(body.contentsBase64)) {
            sendJson(res, 400, { error: 'Choose a valid .xlsx workbook no larger than 10 MB.' });
            return;
        }
        if (body.contentsBase64.length > MAX_UPLOAD_BASE64_LENGTH) {
            sendJson(res, 413, { error: 'The XLSX file must be no larger than 10 MB.' });
            return;
        }

        const workbookBuffer = Buffer.from(body.contentsBase64, 'base64');
        if (workbookBuffer.length === 0 || workbookBuffer.length > MAX_UPLOAD_BYTES
            || workbookBuffer.toString('base64') !== body.contentsBase64) {
            sendJson(res, workbookBuffer.length > MAX_UPLOAD_BYTES ? 413 : 400, {
                error: workbookBuffer.length > MAX_UPLOAD_BYTES
                    ? 'The XLSX file must be no larger than 10 MB.'
                    : 'The XLSX file data is invalid.'
            });
            return;
        }
        if (workbookBuffer[0] !== 0x50 || workbookBuffer[1] !== 0x4b
            || workbookBuffer[2] !== 0x03 || workbookBuffer[3] !== 0x04) {
            sendJson(res, 400, { error: 'The selected file is not a valid XLSX workbook.' });
            return;
        }

        const sourceName = path.basename(body.name);
        const targetName = `${sourceName.slice(0, -5)}.txt`;
        if (sourceName !== body.name || !validateTargetFilename(targetName)) {
            sendJson(res, 400, { error: 'The workbook filename cannot be used as a target list name.' });
            return;
        }

        let numbers;
        try {
            numbers = numbersFromWorkbook(workbookBuffer);
        } catch (error) {
            if (!error.statusCode) throw error;
            sendJson(res, error.statusCode, { error: error.message });
            return;
        }
        if (numbers.length === 0) {
            sendJson(res, 422, { error: 'No phone numbers were found. Enter numbers as text or as whole-number cells with at least six digits.' });
            return;
        }

        const targetPath = path.join(process.cwd(), targetName);
        try {
            fs.writeFileSync(targetPath, `${numbers.join('\n')}\n`, { flag: 'wx' });
        } catch (error) {
            if (error.code === 'EEXIST') {
                sendJson(res, 409, { error: `A target list named "${targetName}" already exists.` });
                return;
            }
            throw error;
        }
        sendJson(res, 201, {
            target: targetName,
            importedNumbers: numbers.length,
            message: `Imported ${numbers.length.toLocaleString()} numbers from all worksheets into ${targetName}.`
        });
        return;
    }

    if (method === 'POST' && pathname === '/api/targets') {
        const body = await readJsonBody(req, MAX_UPLOAD_BYTES + 64 * 1024);
        if (typeof body.name !== 'string' || typeof body.contents !== 'string'
            || Buffer.byteLength(body.contents, 'utf8') > MAX_UPLOAD_BYTES) {
            sendJson(res, 400, { error: 'Choose a .txt file no larger than 10 MB.' });
            return;
        }
        const filename = path.basename(body.name);
        if (filename !== body.name || filename.includes('/') || filename.includes('\\')
            || /[\u0000-\u001f\u007f]/.test(filename) || filename.length <= 4
            || !filename.endsWith('.txt') || filename.includes('report_') || filename.includes('result_')) {
            sendJson(res, 400, { error: 'Target filename must be a valid .txt filename and cannot contain report_ or result_.' });
            return;
        }
        const targetPath = path.join(process.cwd(), filename);
        if (fs.existsSync(targetPath)) {
            sendJson(res, 409, { error: 'A file with that name already exists.' });
            return;
        }
        try {
            fs.writeFileSync(targetPath, body.contents, { flag: 'wx' });
        } catch (error) {
            if (error.code === 'EEXIST') {
                sendJson(res, 409, { error: 'A file with that name already exists.' });
                return;
            }
            throw error;
        }
        sendJson(res, 201, { target: filename });
        return;
    }
    if (method === 'POST' && pathname.startsWith('/api/targets/') && pathname.endsWith('/delete')) {
        if (scanJob?.status === 'starting' || scanJob?.status === 'running') {
            sendJson(res, 409, { error: 'Target lists cannot be removed while a scan is in progress.' });
            return;
        }
        const filename = pathname.slice('/api/targets/'.length, -'/delete'.length);
        const body = await readJsonBody(req);
        if (body.confirm !== true) {
            sendJson(res, 400, { error: 'Explicit confirmation is required to remove a target list.' });
            return;
        }
        if (!listTargets().includes(filename)) {
            sendJson(res, 404, { error: 'Target list not found.' });
            return;
        }
        fs.unlinkSync(path.join(process.cwd(), filename));
        const checkpointFile = path.join(process.cwd(), `checkpoint_${filename.replace('.txt', '')}.json`);
        const checkpointDeleted = fs.existsSync(checkpointFile);
        if (checkpointDeleted) fs.unlinkSync(checkpointFile);
        sendJson(res, 200, { deleted: filename, checkpointDeleted });
        return;
    }

    if (method === 'POST' && pathname === '/api/senders') {
        if (operationIsRunning()) {
            sendJson(res, 409, { error: 'Another sender or scan operation is already running.' });
            return;
        }
        const body = await readJsonBody(req);
        if (typeof body.phoneNumber !== 'string' || body.phoneNumber.replace(/\D/g, '').length < 6) {
            sendJson(res, 400, { error: 'Enter a valid sender number.' });
            return;
        }
        senderJob = { status: 'running', pairingCode: null, sessionFolder: null, error: null };
        addSender({
            phoneNumber: body.phoneNumber,
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
        sendJson(res, 202, { status: 'running' });
        return;
    }

    if (method === 'POST' && pathname === '/api/senders/check-all') {
        if (operationIsRunning()) {
            sendJson(res, 409, { error: 'Another sender or scan operation is already running.' });
            return;
        }
        const senders = listSenders();
        senderJob = { status: 'running', mode: 'check-all', results: [], pairingCode: null, error: null };
        (async () => {
            await senderHealthPromise;
            for (const folder of senders) {
                const result = await pingSender(folder);
                senderHealth.set(folder, { status: result.status, checkedAt: Date.now() });
                senderJob.results.push(result);
            }
            senderJob.status = 'completed';
        })().catch(error => {
            senderJob.status = 'failed';
            senderJob.error = error.message;
        });
        sendJson(res, 202, { status: 'running' });
        return;
    }

    if (method === 'POST' && pathname === '/api/senders/clean') {
        if (operationIsRunning()) {
            sendJson(res, 409, { error: 'Another sender or scan operation is already running.' });
            return;
        }
        const body = await readJsonBody(req);
        if (body.confirm !== true) {
            sendJson(res, 400, { error: 'Explicit confirmation is required to clean sender sessions.' });
            return;
        }
        const senders = listSenders();
        senderJob = { status: 'running', mode: 'clean', results: [], pairingCode: null, error: null };
        (async () => {
            await senderHealthPromise;
            for (const folder of senders) {
                const result = await pingSender(folder);
                senderHealth.set(folder, { status: result.status, checkedAt: Date.now() });
                if (result.status === 'banned/logged_out' || result.status === 'timeout/dead') {
                    try {
                        fs.rmSync(path.join(process.cwd(), folder), { recursive: true });
                    } catch (error) {
                        senderJob.status = 'failed';
                        senderJob.error = error.message;
                        throw error;
                    }
                    senderHealth.delete(folder);
                    result.deleted = true;
                }
                senderJob.results.push(result);
            }
            senderJob.status = 'completed';
        })().catch(error => {
            senderJob.status = 'failed';
            senderJob.error = error.message;
        });
        sendJson(res, 202, { status: 'running' });
        return;
    }

    const senderMatch = pathname.match(/^\/api\/senders\/(session_[^/\\\u0000-\u001f]+)\/(check|delete)$/);
    if (senderMatch && method === 'POST' && senderMatch[2] === 'check') {
        const folder = senderMatch[1];
        if (!listSenders().includes(folder)) {
            sendJson(res, 404, { error: 'Sender session not found.' });
            return;
        }
        if (operationIsRunning()) {
            sendJson(res, 409, { error: 'Another sender or scan operation is already running.' });
            return;
        }
        senderJob = { status: 'running', sessionFolder: folder, pairingCode: null, error: null };
        Promise.resolve(senderHealthPromise).then(() => pingSender(folder)).then(result => {
            senderHealth.set(folder, { status: result.status, checkedAt: Date.now() });
            senderJob.status = result.status;
            senderJob.results = [result];
        }).catch(error => {
            senderJob.status = 'failed';
            senderJob.error = error.message;
        });
        sendJson(res, 202, { status: 'running' });
        return;
    }
    if (senderMatch && method === 'POST' && senderMatch[2] === 'delete') {
        const body = await readJsonBody(req);
        const folder = senderMatch[1];
        if (body.confirm !== true) {
            sendJson(res, 400, { error: 'Explicit confirmation is required to delete a sender session.' });
            return;
        }
        if (!listSenders().includes(folder)) {
            sendJson(res, 404, { error: 'Sender session not found.' });
            return;
        }
        if (operationIsRunning()) {
            sendJson(res, 409, { error: 'Cannot delete a sender while another operation is running.' });
            return;
        }
        senderJob = { status: 'running', mode: 'delete', sessionFolder: folder, error: null };
        await senderHealthPromise;
        if (scanJob?.status === 'starting' || scanJob?.status === 'running') {
            senderJob = null;
            sendJson(res, 409, { error: 'Cannot delete a sender while a scan is running.' });
            return;
        }
        if (!listSenders().includes(folder)) {
            senderJob = null;
            sendJson(res, 404, { error: 'Sender session not found.' });
            return;
        }
        try {
            fs.rmSync(path.join(process.cwd(), folder), { recursive: true });
        } catch (error) {
            senderJob.status = 'failed';
            senderJob.error = error.message;
            throw error;
        }
        senderHealth.delete(folder);
        senderJob.status = 'completed';
        sendJson(res, 200, { deleted: folder });
        return;
    }

    if (method === 'POST' && pathname === '/api/scan') {
        if (operationIsRunning() || state.isEngineRunning) {
            sendJson(res, 409, { error: 'Another sender or scan operation is already running.' });
            return;
        }
        const body = await readJsonBody(req);
        const availableSenders = listSenders();
        const multiSender = Array.isArray(body.sessionFolders);
        const sessionFolders = multiSender
            ? [...new Set(body.sessionFolders)]
            : [body.sessionFolder];
        if (typeof body.targetFile !== 'string' || !listTargets().includes(body.targetFile)
            || sessionFolders.length === 0
            || sessionFolders.some(folder => typeof folder !== 'string' || !availableSenders.includes(folder))
            || !Number.isSafeInteger(body.batchSize) || body.batchSize < 1
            || typeof body.resume !== 'boolean') {
            sendJson(res, 400, { error: 'Select a target and sender session, enter a positive batch size, and choose checkpoint behavior.' });
            return;
        }
        const pendingHealthCheck = senderHealthPromise;
        scanJob = {
            status: 'starting',
            targetFile: body.targetFile,
            sessionFolder: multiSender ? null : body.sessionFolder,
            sessionFolders: multiSender ? sessionFolders : null,
            senderStatuses: multiSender
                ? Object.fromEntries(sessionFolders.map(folder => [folder, { status: 'checking' }]))
                : null,
            error: null,
            logs: []
        };
        Promise.resolve(pendingHealthCheck).then(() => startEngine(null, {
            targetFile: body.targetFile,
            ...(multiSender
                ? {
                    sessionFolders,
                    onWorkerStatus: (folder, status, error) => {
                        const senderStatus = { status };
                        if (error) senderStatus.error = error;
                        scanJob.senderStatuses[folder] = senderStatus;
                        senderHealth.set(folder, { ...senderStatus, checkedAt: Date.now() });
                    }
                }
                : { sessionFolder: body.sessionFolder }),
            batchSize: body.batchSize,
            resume: body.resume
        })).then(result => {
            scanJob.status = result?.status || 'completed';
        }).catch(error => {
            scanJob.status = 'failed';
            scanJob.error = error.message;
        });
        sendJson(res, 202, { status: 'starting' });
        return;
    }

    if (method === 'POST' && pathname === '/api/shutdown') {
        const body = await readJsonBody(req);
        if (body.confirm !== true) {
            sendJson(res, 400, { error: 'Explicit confirmation is required to shut down the application.' });
            return;
        }
        if (operationIsRunning() || state.isEngineRunning) {
            sendJson(res, 409, { error: 'The application cannot shut down while a scan or sender operation is in progress.' });
            return;
        }
        senderJob = { status: 'running', mode: 'shutdown', error: null };
        try {
            await senderHealthPromise;
        } catch (error) {
            senderJob.status = 'failed';
            senderJob.error = error.message;
            throw error;
        }
        senderJob.status = 'completed';
        res.writeHead(202, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'close'
        });
        res.end(JSON.stringify({ message: 'Application is shutting down.' }), () => {
            server.close((error) => {
                if (error) console.error('failed to close web server:', error);
            });
            server.closeAllConnections?.();
        });
        return;
    }

    sendJson(res, 404, { error: 'Not found.' });
};

const startWebServer = (port = 3000) => new Promise((resolve, reject) => {
    let server;
    server = http.createServer((req, res) => {
        setSecurityHeaders(res);
        if (!validateRequestOrigin(req)) {
            sendJson(res, 403, { error: 'Requests must originate from this local application.' });
            return;
        }
        routeRequest(req, res, server).catch(error => {
            if (res.headersSent) {
                res.destroy(error);
                return;
            }
            sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : 'Request failed.' });
            if (!error.statusCode) console.error('web request failed:', error.stack || error);
        });
    });

    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
        const address = server.address();
        console.log(`Web interface running at http://127.0.0.1:${address.port}`);
        resolve(server);
    });
});

module.exports = { startWebServer };
