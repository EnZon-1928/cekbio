// file: core/scanner.js
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');
const { state: sharedState, saveReport } = require('./state');
const { delay, withTimeout } = require('../utils/helpers');
const { minimalLog } = require('../utils/logger');

const scanStateStorage = new AsyncLocalStorage();
const createEmptyStatistics = () => ({
    registered: 0,
    unregistered: 0,
    bioBusiness: 0,
    noBioBusiness: 0,
    personal: 0
});

const commitBatchState = batchState => {
    sharedState.targetBusiness.push(...batchState.targetBusiness);
    sharedState.targetPersonal.push(...batchState.targetPersonal);
    sharedState.targetUnregistered.push(...batchState.targetUnregistered);
    for (const [key, value] of Object.entries(batchState.statistics)) {
        sharedState.statistics[key] = (sharedState.statistics[key] || 0) + value;
    }
};

const createInputOrderSorter = batches => {
    const positions = new Map();
    let index = 0;
    for (const batch of batches) {
        for (const number of batch) {
            const formattedNumber = `+${number}`;
            const previous = positions.get(formattedNumber);
            if (previous === undefined) positions.set(formattedNumber, index);
            else if (Array.isArray(previous)) previous.push(index);
            else positions.set(formattedNumber, [previous, index]);
            index++;
        }
    }

    return () => {
        for (const key of ['targetBusiness', 'targetPersonal', 'targetUnregistered']) {
            const nextOccurrence = new Map();
            sharedState[key] = sharedState[key]
                .map((entry, originalIndex) => {
                    const occurrences = positions.get(entry.number);
                    const occurrence = nextOccurrence.get(entry.number) || 0;
                    nextOccurrence.set(entry.number, occurrence + 1);
                    return {
                        entry,
                        originalIndex,
                        position: (Array.isArray(occurrences)
                            ? occurrences[occurrence]
                            : occurrence === 0 ? occurrences : undefined) ?? Number.MAX_SAFE_INTEGER
                    };
                })
                .sort((a, b) => a.position - b.position || a.originalIndex - b.originalIndex)
                .map(item => item.entry);
        }
    };
};

const runScannerPool = async (workers, { onWorkerStatus = () => {}, persist = saveReport } = {}) => {
    const sortResultsByInputOrder = createInputOrderSorter(sharedState.batches);
    const completed = new Set(Array.isArray(sharedState.completedBatchIndices)
        ? sharedState.completedBatchIndices
        : Array.from({ length: sharedState.batchIndex }, (_, index) => index));
    const pending = sharedState.batches
        .map((_, index) => index)
        .filter(index => !completed.has(index));
    const activeWorkers = new Set(workers);
    const workersWithCompletedBatch = new Set();
    let saveCounter = 0;
    const setWorkerStatus = (...args) => {
        try {
            onWorkerStatus(...args);
        } catch (error) {
            minimalLog('error', `failed to update status for sender ${args[0]}: ${error.message}`);
        }
    };

    const workerLoop = async worker => {
        while (worker.available && activeWorkers.has(worker)) {
            if (pending.length === 0) return;
            if (workersWithCompletedBatch.has(worker)) {
                const batchDelay = Math.floor(Math.random() * (1000 - 500 + 1)) + 500;
                minimalLog('system', `sender ${worker.folder} cooling down ${batchDelay / 1000} seconds...`);
                await delay(batchDelay, batchDelay);
                if (!worker.available) break;
            }
            const batchIndex = pending.shift();
            if (batchIndex === undefined) return;
            const batchState = {
                ...sharedState,
                isEngineRunning: true,
                batchIndex: 0,
                batches: [sharedState.batches[batchIndex]],
                targetBusiness: [],
                targetPersonal: [],
                targetUnregistered: [],
                statistics: createEmptyStatistics()
            };
            const updateProgress = progress => {
                sharedState.workerProgress[worker.folder] = {
                    batchIndex,
                    totalBatches: sharedState.batches.length,
                    totalTargets: batchState.batches[0].length,
                    ...progress
                };
            };
            batchState.onProgress = updateProgress;

            setWorkerStatus(worker.folder, 'scanning');
            updateProgress({ processedTargets: 0, phase: 'checking numbers' });
            let failureSignal;
            let batchError;
            try {
                const runBatch = scanStateStorage.run(batchState, () => runScanner(worker.sock, {
                    exitOnError: false,
                    persist: false,
                    finalize: false,
                    closeSocket: false,
                    logCompletion: false,
                    logErrors: false
                }));
                failureSignal = worker.watchFailure();
                const result = await Promise.race([
                    runBatch.then(() => ({ success: true }), error => ({ error })),
                    failureSignal.promise
                ]);
                if (!result.success || !worker.available) {
                    throw result.error || new Error(`Sender ${worker.folder} disconnected during a batch.`);
                }
            } catch (error) {
                batchError = error;
            } finally {
                failureSignal?.cancel();
            }

            if (batchError) {
                minimalLog('error', `sender ${worker.folder} failed during a batch; retrying it elsewhere: ${batchError.message}`);
                if (worker.available) {
                    worker.available = false;
                    worker.close(batchError);
                }
                activeWorkers.delete(worker);
                setWorkerStatus(worker.folder, 'inactive', batchError.message);
                delete sharedState.workerProgress[worker.folder];
                pending.unshift(batchIndex);
                continue;
            }

            commitBatchState(batchState);
            delete sharedState.workerProgress[worker.folder];
            completed.add(batchIndex);
            sharedState.completedBatchIndices = [...completed].sort((a, b) => a - b);
            sharedState.batchIndex = 0;
            while (completed.has(sharedState.batchIndex)) sharedState.batchIndex++;
            workersWithCompletedBatch.add(worker);
            saveCounter++;
            setWorkerStatus(worker.folder, 'active');

            if (saveCounter >= 10) {
                sortResultsByInputOrder();
                persist();
                saveCounter = 0;
            }
        }
        if (!worker.available) activeWorkers.delete(worker);
    };

    await Promise.all(workers.map(workerLoop));
    while (pending.length > 0 && activeWorkers.size > 0) {
        await Promise.all([...activeWorkers].map(workerLoop));
    }
    if (pending.length > 0) {
        sharedState.workerProgress = {};
        sharedState.multiSenderScan = true;
        sharedState.completedBatchIndices = [...completed].sort((a, b) => a - b);
        sharedState.batchIndex = 0;
        while (completed.has(sharedState.batchIndex)) sharedState.batchIndex++;
        sortResultsByInputOrder();
        persist();
        minimalLog('error', 'all scan senders are unavailable; remaining batches were saved for resume.');
        return { status: 'paused', completedBatches: completed.size, remainingBatches: pending.length };
    }

    sharedState.batchIndex = sharedState.batches.length;
    sharedState.completedBatchIndices = [];
    sharedState.multiSenderScan = false;
    sharedState.workerProgress = {};
    sortResultsByInputOrder();
    persist();
    minimalLog('done', `[report] business: ${sharedState.targetBusiness.length} | personal: ${sharedState.statistics.personal} | unregistered: ${sharedState.statistics.unregistered}++`);
    minimalLog('system', 'multi-sender scanning process completed.');
    const cleanName = sharedState.activeTargetFile.replace('.txt', '');
    const checkpointFile = `checkpoint_${cleanName}.json`;
    if (cleanName && fs.existsSync(checkpointFile)) fs.unlinkSync(checkpointFile);
    return { status: 'completed', completedBatches: completed.size };
};
const findAttribute = (node, attrName) => {
    if (node?.attrs && node.attrs[attrName]) return node.attrs[attrName];
    if (Array.isArray(node?.content)) {
        for (let child of node.content) {
            if (typeof child === 'object') {
                const result = findAttribute(child, attrName);
                if (result) return result;
            }
        }
    }
    return null;
};

const findTag = (node, tagName) => {
    if (node?.tag === tagName) return node;
    if (Array.isArray(node?.content)) {
        for (let child of node.content) {
            if (typeof child === 'object') {
                const result = findTag(child, tagName);
                if (result) return result;
            }
        }
    }
    return null;
};

const extractText = (content) => {
    if (!content) return null;
    if (typeof content === 'string') return content;
    if (Buffer.isBuffer(content)) return content.toString('utf-8');
    if (content instanceof Uint8Array) return Buffer.from(content).toString('utf-8');
    return String(content);
};

const runScanner = async (sock, {
    exitOnError = true,
    persist = true,
    finalize = true,
    closeSocket = true,
    logCompletion = true,
    logErrors = true
} = {}) => {
    const state = scanStateStorage.getStore() || sharedState;
    try {
        for (; state.batchIndex < state.batches.length; state.batchIndex++) {
            const currentBatch = state.batches[state.batchIndex];
            minimalLog('system', `scanning batch ${state.batchIndex + 1}/${state.batches.length} (${currentBatch.length} targets)...`);
            state.onProgress?.({ processedTargets: 0, phase: 'checking numbers' });

            try {
                const batchJids = currentBatch.map(n => `${n}@s.whatsapp.net`);
                const waResult = await withTimeout(sock.onWhatsApp(...batchJids), 15000);
                let processedTargets = 0;

                if (waResult && waResult.length > 0) {
                    const validTargets = waResult.filter(r => r.exists);
                    const unregisteredTargets = waResult.filter(r => !r.exists);

                    unregisteredTargets.forEach(r => {
                        state.statistics.unregistered++;
                        const rawNumber = r.jid.split('@')[0];
                        const formattedNumber = '+' + rawNumber; 
                        
                        state.targetUnregistered.push({ number: formattedNumber });
                        processedTargets++;
                        state.onProgress?.({ processedTargets, phase: 'checking profiles' });
                    });

                    const parallelPromises = validTargets.map(async (res) => {
                        let progressReported = false;
                        const reportTargetProgress = () => {
                            if (progressReported) return;
                            progressReported = true;
                            processedTargets++;
                            state.onProgress?.({ processedTargets, phase: 'checking profiles' });
                        };
                        const formattedNumber = '+' + res.jid.split('@')[0]; 
                        let bizNode = null;
                        let queryFailed = false;

                        try {
                            const rawQuery = {
                                tag: 'iq',
                                attrs: { to: 's.whatsapp.net', type: 'get', xmlns: 'w:biz' },
                                content: [{
                                    tag: 'business_profile',
                                    attrs: { v: '116' },
                                    content: [{ tag: 'profile', attrs: { jid: res.jid } }]
                                }]
                            };
                            bizNode = await withTimeout(sock.query(rawQuery), 5000);
                        } catch (e) {
                            queryFailed = true;
                            if (!e.message || (!e.message.includes('timeout') && !e.message.includes('waktu tunggu'))) {
                                minimalLog('error', `raw query error [${formattedNumber}]:\n` + e.stack);
                            }
                        }

                        // skip processing if query abruptly failed
                        if (queryFailed) {
                            reportTargetProgress();
                            return null;
                        }

                        let isBusiness = false;
                        let accountTier = 0;
                        let verificationStatus = "[personal]";

                        if (bizNode && bizNode.content) {
                            const identityNode = findTag(bizNode, 'biz_identity_info');
                            
                            // business account validation logic
                            if (identityNode && identityNode.attrs && identityNode.attrs.display_name) {
                                isBusiness = true;
                                verificationStatus = "[regular business]";
                                const typeRaw = identityNode.attrs.type || "smb";
                                const vlevel = identityNode.attrs.vlevel || "unknown";
                                if (vlevel === "high" || typeRaw === "verified") {
                                    verificationStatus = "[official/verified]";
                                    accountTier = 2; 
                                } else if (typeRaw === "smb") {
                                    accountTier = 1; 
                                }
                            }
                        }
                        
                        let targetStatus;
                        let lastUpdate;
                        try {
                            const statusRes = await withTimeout(sock.fetchStatus(res.jid), 5000);
                            if (statusRes && statusRes.status) {
                                targetStatus = statusRes.status;
                                if (statusRes.setAt) {
                                    const dateObj = new Date(statusRes.setAt);
                                    lastUpdate = `${String(dateObj.getDate()).padStart(2, '0')}/${String(dateObj.getMonth() + 1).padStart(2, '0')}/${dateObj.getFullYear()}`;
                                }
                            }
                        } catch (e) {
                            if (!e.message || (!e.message.includes('timeout') && !e.message.includes('waktu tunggu'))) {
                                minimalLog('error', `timeout fetch bio status [${formattedNumber}]:\n` + e.stack);
                            }
                        }

                        if (!isBusiness) {
                            reportTargetProgress();
                            return { 
                                type: 'personal', formattedNumber, finalBio: targetStatus, lastUpdate 
                            };
                        }

                        // business specific variables
                        let displayName;
                        let businessInfo = "(empty)";
                        let businessDesc;
                        let website;
                        let email;
                        let joinTime; 
                        let timezone;
                        let coverStatus;
                        let physicalAddress;
                        let gpsCoordinates;
                        let cartStatus;
                        let botStatus;

                        const identityNodeBiz = findTag(bizNode, 'biz_identity_info');
                        if (identityNodeBiz && identityNodeBiz.attrs && identityNodeBiz.attrs.display_name) {
                            displayName = identityNodeBiz.attrs.display_name;
                        }

                        const categoryNode = findTag(bizNode, 'category');
                        const category = categoryNode ? extractText(categoryNode.content) : "unknown";
                        businessInfo = `${verificationStatus} | ${category}`;
                        
                        const descNode = findTag(bizNode, 'description');
                        if (descNode) businessDesc = extractText(descNode.content);
                        const emailNode = findTag(bizNode, 'email');
                        if (emailNode) email = extractText(emailNode.content);
                        const websiteNode = findTag(bizNode, 'website');
                        if (websiteNode) website = extractText(websiteNode.content);
                        timezone = findAttribute(bizNode, 'timezone') || undefined;
                        
                        const addressNode = findTag(bizNode, 'address');
                        if (addressNode) physicalAddress = extractText(addressNode.content);
                        
                        const latNode = findTag(bizNode, 'latitude');
                        const lonNode = findTag(bizNode, 'longitude');
                        if (latNode && lonNode) gpsCoordinates = `${extractText(latNode.content)}, ${extractText(lonNode.content)}`;
                        
                        const coverExists = findTag(bizNode, 'cover_photo') || findAttribute(bizNode, 'cover_photo_id');
                        if (coverExists) coverStatus = "available";
                        
                        const memberTextNode = findTag(bizNode, 'member_since_text');
                        const memberTsNode = findTag(bizNode, 'member_since_ts');
                        if (memberTextNode) {
                            joinTime = extractText(memberTextNode.content);
                        } else if (memberTsNode) {
                            const tsString = extractText(memberTsNode.content);
                            if (tsString && !isNaN(tsString)) {
                                const d = new Date(parseInt(tsString) * 1000);
                                const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
                                joinTime = `Joined in ${months[d.getMonth()]}, ${d.getFullYear()}`;
                            }
                        }
                        
                        const cartNode = findTag(findTag(bizNode, 'profile_options'), 'cart_enabled');
                        if (cartNode && extractText(cartNode.content) === 'true') cartStatus = "active";
                        
                        const autoNode = findTag(bizNode, 'automated_type');
                        if (autoNode && extractText(autoNode.content) !== 'unknown') botStatus = "detected";

                        let finalBio = businessDesc ? businessDesc : targetStatus;
                        
                        const profileResult = {
                            type: 'business', formattedNumber, businessInfo, finalBio, lastUpdate, website, email, 
                            timezone, joinTime, coverStatus, displayName, physicalAddress, gpsCoordinates, 
                            cartStatus, botStatus, accountTier, verificationStatus 
                        };
                        reportTargetProgress();
                        return profileResult;
                    });

                    const parallelResults = await Promise.all(parallelPromises);
                    const validResults = parallelResults.filter(Boolean);

                    validResults.forEach(data => {
                        state.statistics.registered++; 

                        if (data.type === 'personal') {
                            state.statistics.personal++;
                            
                            state.targetPersonal.push({
                                number: data.formattedNumber,
                                bio: data.finalBio,
                                lastUpdate: data.lastUpdate
                            });
                            minimalLog('hit', `[${data.formattedNumber}] => regular personal`);

                        } else if (data.type === 'business') {
                            let bioFormat = data.finalBio ? data.finalBio.replace(/\n/g, '\n     │             ') : undefined;
                            
                            let logData = `   • ${data.formattedNumber}\n`;
                            logData += `     ├─ name      : ${data.displayName ? data.displayName : "(unnamed)"} ${data.verificationStatus}\n`;
                            logData += `     ├─ category  : ${data.businessInfo}\n`;
                            if (data.joinTime) logData += `     ├─ joined    : ${data.joinTime}\n`;
                            if (data.website) logData += `     ├─ website   : ${data.website}\n`;
                            if (data.email) logData += `     ├─ email     : ${data.email}\n`;
                            if (data.physicalAddress) logData += `     ├─ address   : ${data.physicalAddress}\n`;
                            if (data.gpsCoordinates) logData += `     ├─ gps       : ${data.gpsCoordinates}\n`;
                            if (data.timezone) logData += `     ├─ timezone  : ${data.timezone}\n`; 
                            
                            let cartBotArr = [];
                            if (data.cartStatus) cartBotArr.push("cart active");
                            if (data.botStatus) cartBotArr.push("bot detected");
                            if (cartBotArr.length > 0) logData += `     ├─ cart/bot  : ${cartBotArr.join(' / ')}\n`;
                            
                            if (data.coverStatus) logData += `     ├─ cover     : available\n`;
                            if (data.lastUpdate) logData += `     ├─ update    : ${data.lastUpdate}\n`;
                            if (bioFormat) logData += `     ├─ bio/desc  : ${bioFormat}\n`;
                            
                            let lines = logData.trimEnd().split('\n');
                            for (let i = lines.length - 1; i >= 0; i--) {
                                if (lines[i].includes('├─')) {
                                    lines[i] = lines[i].replace('├─', '└─');
                                    break;
                                }
                            }
                            logData = lines.join('\n');
                            
                            if (data.finalBio) state.statistics.bioBusiness++; else state.statistics.noBioBusiness++;

                            state.targetBusiness.push({
                                number: data.formattedNumber,
                                displayName: data.displayName,
                                timezone: data.timezone,
                                category: data.businessInfo,
                                tier: data.accountTier,
                                logString: logData, 
                                website: data.website,
                                email: data.email,
                                joined: data.joinTime,
                                address: data.physicalAddress,
                                gps: data.gpsCoordinates,
                                cart: data.cartStatus,
                                bot: data.botStatus,
                                cover: data.coverStatus,
                                bio: data.finalBio,
                                lastUpdate: data.lastUpdate
                            });
                            
                            minimalLog('hit', `[${data.formattedNumber}] => ${data.verificationStatus}`);
                        }
                    });
                }
            } catch (e) {
                if (logErrors) minimalLog('error', 'batch scanning interrupted:\n' + e.stack);
                throw e; 
            }
            state.onProgress?.({
                processedTargets: currentBatch.length,
                phase: 'batch complete'
            });

            const isMultipleOf10 = (state.batchIndex + 1) % 10 === 0;
            const isFinished = state.batchIndex === state.batches.length - 1;

            if (persist && (isMultipleOf10 || isFinished)) {
                minimalLog('system', `[auto-save] sorting and writing data (batch ${state.batchIndex + 1})...`);
                saveReport();
            }

            if (state.batchIndex < state.batches.length - 1) {
                const batchDelay = Math.floor(Math.random() * (1000 - 500 + 1)) + 500;
                minimalLog('system', `cooling down ${batchDelay / 1000} seconds...`);
                await delay(batchDelay, batchDelay);
            }
        }

        if (logCompletion) {
            minimalLog('done', `[report] business: ${state.targetBusiness.length} | personal: ${state.statistics.personal} | unregistered: ${state.statistics.unregistered}++`);
            minimalLog('system', 'scanning process completed.');
            console.log('\n[!] press ctrl+c to terminate the process, then restart the script to return to the menu.');
        }
        
        const cleanName = state.activeTargetFile ? state.activeTargetFile.replace('.txt', '') : '';
        if (finalize && cleanName && fs.existsSync(`checkpoint_${cleanName}.json`)) {
            fs.unlinkSync(`checkpoint_${cleanName}.json`);
        }
        
        if (closeSocket) {
            sock.ws.close();
            sock.ev.removeAllListeners();
        }
        return;

    } catch (e) {
        if (logErrors) minimalLog('error', 'fatal scanner failure:\n' + e.stack);
        state.isEngineRunning = false;
        
        if (persist) {
            minimalLog('system', '[memory dump] saving remaining data to disk...');
            saveReport();
        }
        
        if (exitOnError) process.exit(1);
        throw e;
    }
};

module.exports = { runScanner, runScannerPool };