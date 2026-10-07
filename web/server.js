const http = require('http');
const fs = require('fs');
const path = require('path');

const { state } = require('../core/state');
const { startEngine } = require('../core/engine');
const { addSender, pingSender } = require('../core/sender');
const { subscribeLogs } = require('../utils/logger');

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const SESSION_PATTERN = /^session_[^/\\\u0000-\u001f]+$/;
const REPORT_PATTERN = /^report_(business|personal|unregistered)_.*\.txt$/;

let scanJob = null;
let senderJob = null;

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
    .filter(entry => entry.isFile() && entry.name.endsWith('.txt') && !entry.name.includes('report_'))
    .map(entry => entry.name)
    .sort();

const listDownloads = () => fs.readdirSync(process.cwd(), { withFileTypes: true })
    .filter(entry => entry.isFile() && REPORT_PATTERN.test(entry.name))
    .map(entry => entry.name)
    .sort();

const operationIsRunning = () => scanJob?.status === 'starting' || scanJob?.status === 'running'
    || senderJob?.status === 'starting' || senderJob?.status === 'running';

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
        const currentBatch = scanJob?.status === 'completed'
            ? totalBatches
            : Math.min(state.batchIndex + (state.isEngineRunning ? 1 : 0), totalBatches);
        sendJson(res, 200, {
            scan: scanJob ? {
                status: scanJob.status,
                targetFile: scanJob.targetFile,
                sessionFolder: scanJob.sessionFolder,
                error: scanJob.error,
                logs: scanJob.logs,
                currentBatch,
                totalBatches,
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
    if (method === 'GET' && pathname === '/api/reports') {
        sendJson(res, 200, { reports: listDownloads() });
        return;
    }
    if (method === 'GET' && pathname.startsWith('/api/reports/')) {
        const filename = pathname.slice('/api/reports/'.length);
        if (!REPORT_PATTERN.test(filename) || !listDownloads().includes(filename)) {
            sendJson(res, 404, { error: 'Report not found.' });
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
    if (method === 'POST' && pathname.startsWith('/api/reports/') && pathname.endsWith('/delete')) {
        if (scanJob?.status === 'starting' || scanJob?.status === 'running') {
            sendJson(res, 409, { error: 'Reports cannot be removed while a scan is in progress.' });
            return;
        }
        const filename = pathname.slice('/api/reports/'.length, -'/delete'.length);
        const body = await readJsonBody(req);
        if (body.confirm !== true) {
            sendJson(res, 400, { error: 'Explicit confirmation is required to remove a report.' });
            return;
        }
        if (!REPORT_PATTERN.test(filename) || !listDownloads().includes(filename)) {
            sendJson(res, 404, { error: 'Report not found.' });
            return;
        }
        fs.unlinkSync(path.join(process.cwd(), filename));
        sendJson(res, 200, { deleted: filename });
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
            || !filename.endsWith('.txt') || filename.includes('report_')) {
            sendJson(res, 400, { error: 'Target filename must be a valid .txt filename and cannot contain report_.' });
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
            for (const folder of senders) {
                senderJob.results.push(await pingSender(folder));
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
            for (const folder of senders) {
                const result = await pingSender(folder);
                if (result.status === 'banned/logged_out' || result.status === 'timeout/dead') {
                    fs.rmSync(path.join(process.cwd(), folder), { recursive: true });
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
        pingSender(folder).then(result => {
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
        fs.rmSync(path.join(process.cwd(), folder), { recursive: true });
        sendJson(res, 200, { deleted: folder });
        return;
    }

    if (method === 'POST' && pathname === '/api/scan') {
        if (operationIsRunning() || state.isEngineRunning) {
            sendJson(res, 409, { error: 'Another sender or scan operation is already running.' });
            return;
        }
        const body = await readJsonBody(req);
        if (typeof body.targetFile !== 'string' || !listTargets().includes(body.targetFile)
            || typeof body.sessionFolder !== 'string' || !listSenders().includes(body.sessionFolder)
            || !Number.isSafeInteger(body.batchSize) || body.batchSize < 1
            || typeof body.resume !== 'boolean') {
            sendJson(res, 400, { error: 'Select a target and sender, enter a positive batch size, and choose checkpoint behavior.' });
            return;
        }
        scanJob = {
            status: 'starting',
            targetFile: body.targetFile,
            sessionFolder: body.sessionFolder,
            error: null,
            logs: []
        };
        startEngine(null, {
            targetFile: body.targetFile,
            sessionFolder: body.sessionFolder,
            batchSize: body.batchSize,
            resume: body.resume
        }).then(() => {
            scanJob.status = 'completed';
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
