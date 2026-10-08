const $ = (selector) => document.querySelector(selector);

const elements = {
    shutdown: $('#shutdown'),
    confirmationDialog: $('#confirmation-dialog'),
    confirmationTitle: $('#confirmation-title'),
    confirmationMessage: $('#confirmation-message'),
    confirmationCancel: $('#confirmation-cancel'),
    confirmationAccept: $('#confirmation-accept'),
    message: $('#message'),
    senderForm: $('#sender-form'),
    senderJob: $('#sender-job'),
    senders: $('#senders'),
    target: $('#target'),
    targetFiles: $('#target-files'),
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
    progressDetail: $('#progress-detail'),
    stats: $('#stats'),
    logs: $('#logs'),
    reports: $('#reports'),
    reportSearch: $('#report-search'),
    reportCategory: $('#report-category'),
    summaryContext: $('#summary-context'),
    statBusiness: $('#stat-business'),
    statPersonal: $('#stat-personal'),
    statUnregistered: $('#stat-unregistered'),
    statDescriptions: $('#stat-descriptions')
};

const navigationTabs = [...document.querySelectorAll('.nav-tab')];
const navigationPanels = navigationTabs.map(tab => document.getElementById(tab.getAttribute('aria-controls')));

const activateView = (viewName, focusTab = false) => {
    const activeTab = navigationTabs.find(tab => tab.dataset.view === viewName);
    if (!activeTab) return;

    for (const tab of navigationTabs) {
        const selected = tab === activeTab;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
    }
    for (const panel of navigationPanels) {
        panel.hidden = panel.id !== activeTab.getAttribute('aria-controls');
    }
    if (focusTab) activeTab.focus();
};

for (const tab of navigationTabs) {
    tab.addEventListener('click', () => activateView(tab.dataset.view));
    tab.addEventListener('keydown', event => {
        const currentIndex = navigationTabs.indexOf(tab);
        let nextIndex;
        if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % navigationTabs.length;
        else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + navigationTabs.length) % navigationTabs.length;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = navigationTabs.length - 1;
        else return;

        event.preventDefault();
        const nextTab = navigationTabs[nextIndex];
        activateView(nextTab.dataset.view, true);
    });
}

let confirmationResolver = null;
let confirmationCloseTimer = null;

const confirmAction = ({ title, message, confirmLabel }) => new Promise(resolve => {
    if (confirmationResolver) return resolve(false);

    confirmationResolver = resolve;
    elements.confirmationTitle.textContent = title;
    elements.confirmationMessage.textContent = message;
    elements.confirmationAccept.textContent = confirmLabel;
    elements.confirmationDialog.classList.remove('is-visible');
    elements.confirmationDialog.showModal();
    elements.confirmationCancel.focus();
    requestAnimationFrame(() => elements.confirmationDialog.classList.add('is-visible'));
});

const closeConfirmation = (confirmed) => {
    if (!confirmationResolver) return;
    const resolve = confirmationResolver;
    confirmationResolver = null;
    elements.confirmationDialog.classList.remove('is-visible');

    const finishClose = () => {
        clearTimeout(confirmationCloseTimer);
        confirmationCloseTimer = null;
        elements.confirmationDialog.removeEventListener('transitionend', finishOnTransitionEnd);
        if (elements.confirmationDialog.open) elements.confirmationDialog.close();
        resolve(confirmed);
    };
    const finishOnTransitionEnd = (event) => {
        if (event.target === elements.confirmationDialog && event.propertyName === 'opacity') finishClose();
    };

    confirmationCloseTimer = window.setTimeout(finishClose, 200);
    elements.confirmationDialog.addEventListener('transitionend', finishOnTransitionEnd);
};

elements.confirmationCancel.addEventListener('click', () => closeConfirmation(false));
elements.confirmationAccept.addEventListener('click', () => closeConfirmation(true));
elements.confirmationDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeConfirmation(false);
});
elements.confirmationDialog.addEventListener('click', (event) => {
    if (event.target === elements.confirmationDialog) closeConfirmation(false);
});

elements.shutdown.addEventListener('click', async () => {
    if (!await confirmAction({
        title: 'Shut down cekbio?',
        message: 'This will stop the local application. Any active scan or sender operation must finish first. Your files and sessions will remain unchanged.',
        confirmLabel: 'Shut down'
    })) return;
    elements.shutdown.disabled = true;
    try {
        await request('/api/shutdown', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ confirm: true })
        });
        showMessage('Application is shutting down. You can close this tab.');
    } catch (error) {
        elements.shutdown.disabled = false;
        showMessage(error.message, true);
    }
});

$('#check-all').addEventListener('click', async () => {
    try {
        await request('/api/senders/check-all', { method: 'POST' });
        showMessage('Sender check started.');
        pollStatus();
    } catch (error) {
        showMessage(error.message, true);
    }
});

$('#clean-senders').addEventListener('click', async () => {
    if (!await confirmAction({
        title: 'Remove inactive senders?',
        message: 'All sender sessions will be checked. Sessions that time out, are banned, or are logged out will be removed.',
        confirmLabel: 'Check and remove'
    })) return;
    try {
        await request('/api/senders/clean', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ confirm: true })
        });
        showMessage('Sender check and cleanup started.');
        pollStatus();
    } catch (error) {
        showMessage(error.message, true);
    }
});

let targets = [];
let checkpoints = {};
let senders = [];
let reports = [];

const request = async (url, options) => {
    const response = await fetch(url, options);
    const result = response.headers.get('content-type')?.includes('application/json')
        ? await response.json()
        : null;
    if (!response.ok) throw new Error(result?.error || `Request failed (${response.status}).`);
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
    if (!targets.length) elements.target.append(makeOption('', 'Upload a target list to continue'));
    elements.targetFiles.replaceChildren();
    if (!targets.length) {
        elements.targetFiles.textContent = 'No target lists are available.';
    } else {
        for (const filename of targets) {
            const row = document.createElement('div');
            row.className = 'list-row';
            const name = document.createElement('span');
            name.textContent = filename;
            const remove = document.createElement('button');
            remove.className = 'text-button danger';
            remove.type = 'button';
            remove.textContent = 'Remove';
            remove.addEventListener('click', () => deleteTarget(filename));
            row.append(name, remove);
            elements.targetFiles.append(row);
        }
    }
    updateCheckpoint();
};

const refreshSenders = async () => {
    const result = await request('/api/senders');
    senders = result.senders;
    elements.senders.replaceChildren();
    elements.senderSelect.replaceChildren(...senders.map(name => makeOption(name, name.replace('_', ' '))));
    if (!senders.length) {
        elements.senders.textContent = 'No sender sessions found. Add a sender to get started.';
        elements.senderSelect.append(makeOption('', 'No sender sessions available'));
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
        check.textContent = 'Check';
        check.addEventListener('click', () => checkSender(folder));
        const remove = document.createElement('button');
        remove.className = 'text-button danger';
        remove.type = 'button';
        remove.textContent = 'Remove';
        remove.addEventListener('click', () => deleteSender(folder));
        actions.append(check, remove);
        row.append(name, actions);
        elements.senders.append(row);
    }
};

const refreshReports = async () => {
    const result = await request('/api/reports');
    reports = result.reports;
    renderReports();
};

const renderReports = () => {
    elements.reports.replaceChildren();
    if (!reports.length) {
        elements.reports.textContent = 'No reports are available yet.';
        return;
    }
    const searchTerm = elements.reportSearch.value.trim().toLowerCase();
    const selectedCategory = elements.reportCategory.value;
    const filteredReports = reports.filter(filename => {
        const matchesSearch = filename.toLowerCase().includes(searchTerm);
        const category = filename.match(/^report_(business|personal|unregistered)_/)?.[1];
        const matchesCategory = selectedCategory === 'all' || category === selectedCategory;
        return matchesSearch && matchesCategory;
    });
    if (!filteredReports.length) {
        elements.reports.textContent = 'No reports match the selected filters.';
        return;
    }
    for (const filename of filteredReports) {
        const row = document.createElement('div');
        row.className = 'list-row';
        const name = document.createElement('span');
        name.textContent = filename;
        const download = document.createElement('a');
        download.className = 'text-button';
        download.href = `/api/reports/${encodeURIComponent(filename)}`;
        download.textContent = 'Download ↓';
        const remove = document.createElement('button');
        remove.className = 'text-button danger';
        remove.type = 'button';
        remove.textContent = 'Remove';
        remove.addEventListener('click', () => deleteReport(filename));
        const actions = document.createElement('div');
        actions.className = 'row-actions';
        actions.append(download, remove);
        row.append(name, actions);
        elements.reports.append(row);
    }
};

const renderSummary = (scan) => {
    if (!scan) {
        elements.summaryContext.textContent = 'No scan data available';
        elements.statBusiness.textContent = '—';
        elements.statPersonal.textContent = '—';
        elements.statUnregistered.textContent = '—';
        elements.statDescriptions.textContent = '—';
        return;
    }

    const statistics = scan.statistics;
    const statusContext = {
        starting: 'Preparing scan',
        running: 'Current scan · In progress',
        completed: 'Latest scan · Completed',
        failed: 'Latest scan · Failed'
    };
    elements.summaryContext.textContent = statusContext[scan.status] || 'Latest scan';
    elements.statBusiness.textContent = (
        Number(statistics?.bioBusiness || 0) + Number(statistics?.noBioBusiness || 0)
    ).toLocaleString();
    elements.statPersonal.textContent = Number(statistics?.personal || 0).toLocaleString();
    elements.statUnregistered.textContent = Number(statistics?.unregistered || 0).toLocaleString();
    elements.statDescriptions.textContent = Number(statistics?.bioBusiness || 0).toLocaleString();
};

const updateCheckpoint = () => {
    const checkpoint = checkpoints[elements.target.value];
    elements.checkpointBox.hidden = !checkpoint;
    elements.resume.disabled = Boolean(checkpoint?.invalid);
    elements.resume.checked = !checkpoint?.invalid;
    if (checkpoint) {
        elements.checkpointInfo.textContent = checkpoint.invalid
            ? 'The checkpoint could not be read. The next scan will start from the beginning.'
            : `Last completed batch: ${checkpoint.batchIndex} of ${checkpoint.totalBatches}.`;
    }
};

const checkSender = async (folder) => {
    try {
        await request(`/api/senders/${encodeURIComponent(folder)}/check`, { method: 'POST' });
        showMessage(`Sender check started for ${folder}.`);
        pollStatus();
    } catch (error) {
        showMessage(error.message, true);
    }
};

const deleteSender = async (folder) => {
    if (!await confirmAction({
        title: 'Remove sender session?',
        message: `The local credentials for ${folder} will be permanently deleted. This action cannot be undone.`,
        confirmLabel: 'Remove sender'
    })) return;
    try {
        await request(`/api/senders/${encodeURIComponent(folder)}/delete`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ confirm: true })
        });
        await refreshSenders();
        showMessage(`${folder} was removed.`);
    } catch (error) {
        showMessage(error.message, true);
    }
};

const deleteTarget = async (filename) => {
    if (!await confirmAction({
        title: 'Remove target list?',
        message: `"${filename}" and its checkpoint will be permanently deleted. Generated reports will not be affected.`,
        confirmLabel: 'Remove target'
    })) return;
    try {
        await request(`/api/targets/${encodeURIComponent(filename)}/delete`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ confirm: true })
        });
        await refreshTargets();
        showMessage(`Target list "${filename}" was removed.`);
    } catch (error) {
        showMessage(error.message, true);
    }
};

const deleteReport = async (filename) => {
    if (!await confirmAction({
        title: 'Remove result file?',
        message: `"${filename}" will be permanently deleted. This action cannot be undone.`,
        confirmLabel: 'Remove file'
    })) return;
    try {
        await request(`/api/reports/${encodeURIComponent(filename)}/delete`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ confirm: true })
        });
        await refreshReports();
        showMessage(`"${filename}" was removed.`);
    } catch (error) {
        showMessage(error.message, true);
    }
};

const senderStatusLabels = {
    running: 'In progress',
    starting: 'Starting',
    completed: 'Completed',
    connected: 'Connected',
    alive: 'Connected',
    failed: 'Failed',
    error: 'Error',
    timeout: 'Timed out',
    'timeout/dead': 'Timed out or unavailable',
    'banned/logged_out': 'Banned or logged out'
};

const formatScanLog = ({ timestamp, context, message }) => {
    const batch = message.match(/^scanning batch (\d+)\/(\d+) \((\d+) targets\)\.\.\.$/);
    if (batch) {
        return `[${timestamp}] INFO  Scanning batch ${batch[1]} of ${batch[2]} (${batch[3]} targets).`;
    }

    const saved = message.match(/^\[auto-save\] sorting and writing data \(batch (\d+)\)\.\.\.$/);
    if (saved) return `[${timestamp}] INFO  Saving results after batch ${saved[1]}.`;

    const cooldown = message.match(/^cooling down ([\d.]+) seconds\.\.\.$/);
    if (cooldown) return `[${timestamp}] INFO  Cooling down for ${cooldown[1]} seconds.`;

    const hit = message.match(/^\[(.+?)\] => (.+)$/);
    if (context === 'hit' && hit) {
        const accountType = hit[2] === 'regular personal'
            ? 'Personal account found'
            : hit[2] === '[official/verified]'
                ? 'Verified business account found'
                : hit[2] === '[regular business]'
                    ? 'Business account found'
                    : `${hit[2]} account found`;
        return `[${timestamp}] MATCH ${accountType}: ${hit[1]}.`;
    }

    const summary = message.match(/^\[report\] business: (\d+) \| personal: (\d+) \| unregistered: (\d+)\+\+$/);
    if (summary) {
        return `[${timestamp}] DONE  Scan summary — business: ${summary[1]}, personal: ${summary[2]}, unregistered: ${summary[3]}.`;
    }

    if (message === 'scanning process completed.') return `[${timestamp}] DONE  Scan completed.`;
    if (message === '[memory dump] saving remaining data to disk...') {
        return `[${timestamp}] INFO  Saving remaining results to disk.`;
    }

    if (message.startsWith('raw query error [')) {
        const number = message.match(/^raw query error \[(.+?)\]/)?.[1];
        return `[${timestamp}] WARN  Could not retrieve the business profile${number ? ` for ${number}` : ''}.`;
    }
    if (message.startsWith('timeout fetch bio status [')) {
        const number = message.match(/^timeout fetch bio status \[(.+?)\]/)?.[1];
        return `[${timestamp}] WARN  Could not retrieve the account status${number ? ` for ${number}` : ''}.`;
    }
    if (message.startsWith('batch scanning interrupted:')) {
        const detail = message.split('\n')[1]?.trim();
        return `[${timestamp}] ERROR Batch scanning was interrupted${detail ? `: ${detail}` : '.'}`;
    }
    if (message.startsWith('fatal scanner failure:')) {
        const detail = message.split('\n')[1]?.trim();
        return `[${timestamp}] ERROR Scan failed${detail ? `: ${detail}` : '.'}`;
    }

    const label = context === 'error' ? 'ERROR' : context === 'done' ? 'DONE' : 'INFO ';
    const cleanMessage = message.split('\n')[0].trim();
    return `[${timestamp}] ${label} ${cleanMessage}`;
};

const displayStatus = (result) => {
    const scan = result.scan;
    const sender = result.sender;
    const senderIsActive = ['starting', 'running'].includes(sender?.status);
    const scanIsActive = ['starting', 'running'].includes(scan?.status);
    const senderTab = $('#nav-senders');
    const scanTab = $('#nav-scan');
    const senderActivity = $('#nav-senders-activity');
    const scanActivity = $('#nav-scan-activity');
    senderActivity.hidden = !senderIsActive;
    scanActivity.hidden = !scanIsActive;
    senderTab.setAttribute('aria-label', senderIsActive ? 'Senders, operation in progress' : 'Senders');
    scanTab.setAttribute('aria-label', scanIsActive ? 'Scan, operation in progress' : 'Scan');
    renderSummary(scan);
    if (sender) {
        elements.senderJob.hidden = false;
        elements.senderJob.replaceChildren();
        const status = document.createElement('p');
        status.textContent = `Status: ${senderStatusLabels[sender.status] || sender.status}`;
        elements.senderJob.append(status);
        if (sender.sessionFolder) {
            const session = document.createElement('p');
            session.textContent = `Session: ${sender.sessionFolder}`;
            elements.senderJob.append(session);
        }
        if (sender.pairingCode) {
            const code = document.createElement('strong');
            code.className = 'pairing-code';
            code.textContent = sender.pairingCode;
            elements.senderJob.append(code);
            const pairingInstructions = document.createElement('p');
            pairingInstructions.textContent = 'Enter this code in WhatsApp to link the sender.';
            elements.senderJob.append(pairingInstructions);
        }
        if (sender.error) {
            const error = document.createElement('p');
            error.className = 'error-text';
            error.textContent = `Error: ${sender.error}`;
            elements.senderJob.append(error);
        }
        if (sender.results?.length) {
            const results = document.createElement('ul');
            for (const result of sender.results) {
                const item = document.createElement('li');
                item.textContent = `${result.folder}: ${senderStatusLabels[result.status] || result.status}${result.deleted ? ' · Removed' : ''}`;
                results.append(item);
            }
            elements.senderJob.append(results);
        }
    }
    if (!scan) return;
    const labels = {
        starting: 'Preparing',
        running: 'In progress',
        completed: 'Completed',
        failed: 'Failed'
    };
    elements.scanState.textContent = labels[scan.status] || scan.status;
    elements.scanState.className = `status-pill ${scan.status}`;
    elements.progress.hidden = false;
    elements.progressTitle.textContent = `${scan.targetFile} · ${scan.sessionFolder}`;
    elements.progressCount.textContent = `${scan.currentBatch} of ${scan.totalBatches} batches`;
    const percent = scan.totalTargets ? Math.min(100, scan.completedTargets / scan.totalTargets * 100) : 0;
    elements.progressBar.style.width = `${percent}%`;
    elements.progressDetail.textContent = `${Number(scan.completedTargets || 0).toLocaleString()} of ${Number(scan.totalTargets || 0).toLocaleString()} targets completed`;
    elements.stats.textContent = scan.statistics
        ? `Business: ${scan.statistics.bioBusiness + scan.statistics.noBioBusiness} · Personal: ${scan.statistics.personal} · Unregistered: ${scan.statistics.unregistered}`
        : '';
    elements.logs.textContent = scan.logs?.length
        ? scan.logs.map(formatScanLog).join('\n')
        : 'Waiting for scan activity...';
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
elements.reportSearch.addEventListener('input', renderReports);
elements.reportCategory.addEventListener('change', renderReports);
$('#refresh').addEventListener('click', () => {
    Promise.all([refreshTargets(), refreshSenders(), refreshReports(), pollStatus()])
        .catch(error => showMessage(error.message, true));

    activateView('scan');
});
$('#upload-trigger').addEventListener('click', () => elements.upload.click());
elements.upload.addEventListener('change', async () => {
    const file = elements.upload.files[0];
    if (!file) return;
    try {
        if (!file.name.toLowerCase().endsWith('.txt') || file.size > 10 * 1024 * 1024) {
            throw new Error('Select a .txt file no larger than 10 MB.');
        }
        await request('/api/targets', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: file.name, contents: await file.text() })
        });
        await refreshTargets();
        elements.target.value = file.name;
        updateCheckpoint();
        showMessage(`${file.name} uploaded successfully.`);
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
        elements.senderJob.textContent = 'Requesting pairing code...';
        elements.senderForm.reset();
        showMessage('Sender pairing started.');
        pollStatus();
    } catch (error) {
        showMessage(error.message, true);
    }
});

elements.scanForm.addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(elements.scanForm);
    if (!form.get('targetFile') || !form.get('sessionFolder')) {
        showMessage('Upload a target list and add a sender before starting a scan.', true);
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
        showMessage('Scan started.');
        pollStatus();
    } catch (error) {
        showMessage(error.message, true);
    }
});

Promise.all([refreshTargets(), refreshSenders(), refreshReports(), pollStatus()])
    .catch(error => showMessage(error.message, true));
