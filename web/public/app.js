const $ = (selector) => document.querySelector(selector);

const elements = {
    message: $('#message'),
    senderForm: $('#sender-form'),
    senderJob: $('#sender-job'),
    senders: $('#senders'),
    target: $('#target'),
    upload: $('#upload'),
    senderSelect: $('#sender-select'),
    scanForm: $('#scan-form'),
    startScan: $('#start-scan'),
    scanState: $('#scan-state'),
    checkpointBox: $('#checkpoint-box'),
    checkpointInfo: $('#checkpoint-info'),
    resume: $('#resume'),
    progress: $('#progress'),
    progressTitle: $('#progress-title'),
    progressCount: $('#progress-count'),
    progressBar: $('#progress-bar'),
    stats: $('#stats'),
    logs: $('#logs'),
    reports: $('#reports')
};

$('#check-all').addEventListener('click', async () => {
    try {
        await request('/api/senders/check-all', { method: 'POST' });
        showMessage('Pengecekan semua sender dimulai.');
        pollStatus();
    } catch (error) {
        showMessage(error.message, true);
    }
});

$('#clean-senders').addEventListener('click', async () => {
    if (!window.confirm('Cek semua sender dan hapus yang timeout, banned, atau logout?')) return;
    try {
        await request('/api/senders/clean', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ confirm: true })
        });
        showMessage('Pengecekan dan pembersihan sender dimulai.');
        pollStatus();
    } catch (error) {
        showMessage(error.message, true);
    }
});

let targets = [];
let checkpoints = {};
let senders = [];

const request = async (url, options) => {
    const response = await fetch(url, options);
    const result = response.headers.get('content-type')?.includes('application/json')
        ? await response.json()
        : null;
    if (!response.ok) throw new Error(result?.error || `Request gagal (${response.status}).`);
    return result;
};

const showMessage = (text, isError = false) => {
    elements.message.textContent = text;
    elements.message.className = `message${isError ? ' error' : ''}`;
    elements.message.hidden = false;
    window.setTimeout(() => { elements.message.hidden = true; }, 6000);
};

const makeOption = (value, label) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
};

const refreshTargets = async () => {
    const result = await request('/api/targets');
    targets = result.targets;
    checkpoints = result.checkpoints;
    const selected = elements.target.value;
    elements.target.replaceChildren(...targets.map(name => makeOption(name, name)));
    if (targets.includes(selected)) elements.target.value = selected;
    if (!targets.length) elements.target.append(makeOption('', 'Unggah file target terlebih dahulu'));
    updateCheckpoint();
};

const refreshSenders = async () => {
    const result = await request('/api/senders');
    senders = result.senders;
    elements.senders.replaceChildren();
    elements.senderSelect.replaceChildren(...senders.map(name => makeOption(name, name.replace('_', ' '))));
    if (!senders.length) {
        elements.senders.textContent = 'Belum ada sender. Tambahkan sender untuk mulai.';
        elements.senderSelect.append(makeOption('', 'Belum ada sender'));
        return;
    }
    for (const folder of senders) {
        const row = document.createElement('div');
        row.className = 'list-row';
        const name = document.createElement('strong');
        name.textContent = folder.replace('_', ' ');
        const actions = document.createElement('div');
        actions.className = 'row-actions';
        const check = document.createElement('button');
        check.className = 'text-button';
        check.type = 'button';
        check.textContent = 'Cek';
        check.addEventListener('click', () => checkSender(folder));
        const remove = document.createElement('button');
        remove.className = 'text-button danger';
        remove.type = 'button';
        remove.textContent = 'Hapus';
        remove.addEventListener('click', () => deleteSender(folder));
        actions.append(check, remove);
        row.append(name, actions);
        elements.senders.append(row);
    }
};

const refreshReports = async () => {
    const { reports } = await request('/api/reports');
    elements.reports.replaceChildren();
    if (!reports.length) {
        elements.reports.textContent = 'Belum ada laporan.';
        return;
    }
    for (const filename of reports) {
        const row = document.createElement('div');
        row.className = 'list-row';
        const name = document.createElement('span');
        name.textContent = filename;
        const download = document.createElement('a');
        download.className = 'text-button';
        download.href = `/api/reports/${encodeURIComponent(filename)}`;
        download.textContent = 'Unduh ↓';
        row.append(name, download);
        elements.reports.append(row);
    }
};

const updateCheckpoint = () => {
    const checkpoint = checkpoints[elements.target.value];
    elements.checkpointBox.hidden = !checkpoint;
    elements.resume.disabled = Boolean(checkpoint?.invalid);
    elements.resume.checked = !checkpoint?.invalid;
    if (checkpoint) {
        elements.checkpointInfo.textContent = checkpoint.invalid
            ? 'Checkpoint tidak terbaca; sesuai alur lama, scan berikutnya akan mulai dari awal.'
            : `Batch terakhir ${checkpoint.batchIndex} dari ${checkpoint.totalBatches}.`;
    }
};

const checkSender = async (folder) => {
    try {
        await request(`/api/senders/${encodeURIComponent(folder)}/check`, { method: 'POST' });
        showMessage(`Pengecekan ${folder} dimulai.`);
        pollStatus();
    } catch (error) {
        showMessage(error.message, true);
    }
};

const deleteSender = async (folder) => {
    if (!window.confirm(`Hapus sesi ${folder}? Kredensial sesi lokal akan dihapus permanen.`)) return;
    try {
        await request(`/api/senders/${encodeURIComponent(folder)}/delete`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ confirm: true })
        });
        await refreshSenders();
        showMessage(`${folder} dihapus.`);
    } catch (error) {
        showMessage(error.message, true);
    }
};

const displayStatus = (result) => {
    const scan = result.scan;
    const sender = result.sender;
    if (sender) {
        elements.senderJob.hidden = false;
        elements.senderJob.replaceChildren();
        const status = document.createElement('p');
        status.textContent = sender.status === 'running' ? 'Operasi sender sedang berjalan...' : `Status sender: ${sender.status}`;
        elements.senderJob.append(status);
        if (sender.sessionFolder) {
            const session = document.createElement('p');
            session.textContent = `Sesi: ${sender.sessionFolder}`;
            elements.senderJob.append(session);
        }
        if (sender.pairingCode) {
            const code = document.createElement('strong');
            code.className = 'pairing-code';
            code.textContent = sender.pairingCode;
            elements.senderJob.append(code);
        }
        if (sender.error) {
            const error = document.createElement('p');
            error.className = 'error-text';
            error.textContent = sender.error;
            elements.senderJob.append(error);
        }
        if (sender.results?.length) {
            const results = document.createElement('ul');
            for (const result of sender.results) {
                const item = document.createElement('li');
                item.textContent = `${result.folder}: ${result.status}${result.deleted ? ' · dihapus' : ''}`;
                results.append(item);
            }
            elements.senderJob.append(results);
        }
    }
    if (!scan) return;
    const labels = {
        starting: 'Menyiapkan',
        running: 'Berjalan',
        completed: 'Selesai',
        failed: 'Gagal'
    };
    elements.scanState.textContent = labels[scan.status] || scan.status;
    elements.scanState.className = `status-pill ${scan.status}`;
    elements.progress.hidden = false;
    elements.progressTitle.textContent = `${scan.targetFile} · ${scan.sessionFolder}`;
    elements.progressCount.textContent = `${scan.currentBatch} / ${scan.totalBatches} batch`;
    const percent = scan.totalBatches ? Math.min(100, scan.currentBatch / scan.totalBatches * 100) : 0;
    elements.progressBar.style.width = `${percent}%`;
    elements.stats.textContent = scan.statistics
        ? `Business ${scan.statistics.bioBusiness + scan.statistics.noBioBusiness} · Personal ${scan.statistics.personal} · Tidak terdaftar ${scan.statistics.unregistered}`
        : '';
    elements.logs.textContent = scan.logs?.length
        ? scan.logs.map(entry => `[${entry.timestamp}] ${entry.context}: ${entry.message}`).join('\n')
        : 'Menunggu aktivitas scan...';
    elements.startScan.disabled = ['starting', 'running'].includes(scan.status);
    if (scan.status === 'failed' && scan.error) showMessage(scan.error, true);
    if (scan.status === 'completed') refreshReports().catch(error => showMessage(error.message, true));
};

const pollStatus = async () => {
    try {
        const result = await request('/api/status');
        displayStatus(result);
        if (result.sender && ['running', 'starting'].includes(result.sender.status)) {
            window.setTimeout(pollStatus, 2000);
        } else if (result.scan && ['starting', 'running'].includes(result.scan.status)) {
            window.setTimeout(pollStatus, 2000);
        } else {
            await Promise.all([refreshSenders(), refreshTargets(), refreshReports()]);
        }
    } catch (error) {
        showMessage(error.message, true);
    }
};

elements.target.addEventListener('change', updateCheckpoint);
$('#refresh').addEventListener('click', () => {
    Promise.all([refreshTargets(), refreshSenders(), refreshReports(), pollStatus()])
        .catch(error => showMessage(error.message, true));
});
$('#upload-trigger').addEventListener('click', () => elements.upload.click());
elements.upload.addEventListener('change', async () => {
    const file = elements.upload.files[0];
    if (!file) return;
    try {
        if (!file.name.toLowerCase().endsWith('.txt') || file.size > 10 * 1024 * 1024) {
            throw new Error('Pilih file .txt berukuran maksimal 10 MB.');
        }
        await request('/api/targets', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: file.name, contents: await file.text() })
        });
        await refreshTargets();
        elements.target.value = file.name;
        updateCheckpoint();
        showMessage(`${file.name} berhasil diunggah.`);
    } catch (error) {
        showMessage(error.message, true);
    } finally {
        elements.upload.value = '';
    }
});

elements.senderForm.addEventListener('submit', async event => {
    event.preventDefault();
    const phoneNumber = new FormData(elements.senderForm).get('phoneNumber');
    try {
        await request('/api/senders', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ phoneNumber })
        });
        elements.senderJob.hidden = false;
        elements.senderJob.textContent = 'Meminta pairing code...';
        elements.senderForm.reset();
        showMessage('Proses pairing dimulai.');
        pollStatus();
    } catch (error) {
        showMessage(error.message, true);
    }
});

elements.scanForm.addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(elements.scanForm);
    if (!form.get('targetFile') || !form.get('sessionFolder')) {
        showMessage('Unggah file target dan tambahkan sender terlebih dahulu.', true);
        return;
    }
    try {
        await request('/api/scan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                targetFile: form.get('targetFile'),
                sessionFolder: form.get('sessionFolder'),
                batchSize: Number(form.get('batchSize')),
                resume: elements.checkpointBox.hidden ? false : elements.resume.checked
            })
        });
        elements.startScan.disabled = true;
        showMessage('Scan dimulai.');
        pollStatus();
    } catch (error) {
        showMessage(error.message, true);
    }
});

Promise.all([refreshTargets(), refreshSenders(), refreshReports(), pollStatus()])
    .catch(error => showMessage(error.message, true));
