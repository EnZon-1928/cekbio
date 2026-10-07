// file: core/scanner.js
const fs = require('fs');
const { state, saveReport } = require('./state');
const { delay, withTimeout } = require('../utils/helpers');
const { minimalLog } = require('../utils/logger');

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

const runScanner = async (sock) => {
    try {
        for (; state.batchIndex < state.batches.length; state.batchIndex++) {
            const currentBatch = state.batches[state.batchIndex];
            minimalLog('system', `scanning batch ${state.batchIndex + 1}/${state.batches.length} (${currentBatch.length} targets)...`);

            try {
                const batchJids = currentBatch.map(n => `${n}@s.whatsapp.net`);
                const waResult = await withTimeout(sock.onWhatsApp(...batchJids), 15000);

                if (waResult && waResult.length > 0) {
                    const validTargets = waResult.filter(r => r.exists);
                    const unregisteredTargets = waResult.filter(r => !r.exists);

                    unregisteredTargets.forEach(r => {
                        state.statistics.unregistered++;
                        const rawNumber = r.jid.split('@')[0];
                        const formattedNumber = '+' + rawNumber; 
                        
                        state.targetUnregistered.push({ number: formattedNumber });
                    });

                    const parallelPromises = validTargets.map(async (res) => {
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
                        if (queryFailed) return null;

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
                        
                        return { 
                            type: 'business', formattedNumber, businessInfo, finalBio, lastUpdate, website, email, 
                            timezone, joinTime, coverStatus, displayName, physicalAddress, gpsCoordinates, 
                            cartStatus, botStatus, accountTier, verificationStatus 
                        };
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
                minimalLog('error', 'batch scanning interrupted:\n' + e.stack);
                throw e; 
            }

            const isMultipleOf10 = (state.batchIndex + 1) % 10 === 0;
            const isFinished = state.batchIndex === state.batches.length - 1;

            if (isMultipleOf10 || isFinished) {
                minimalLog('system', `[auto-save] sorting and writing data (batch ${state.batchIndex + 1})...`);
                saveReport();
            }

            if (state.batchIndex < state.batches.length - 1) {
                const batchDelay = Math.floor(Math.random() * (1000 - 500 + 1)) + 500;
                minimalLog('system', `cooling down ${batchDelay / 1000} seconds...`);
                await delay(batchDelay, batchDelay);
            }
        }

        minimalLog('done', `[report] business: ${state.targetBusiness.length} | personal: ${state.statistics.personal} | unregistered: ${state.statistics.unregistered}++`);
        minimalLog('system', 'scanning process completed.');
        console.log('\n[!] press ctrl+c to terminate the process, then restart the script to return to the menu.');
        
        const cleanName = state.activeTargetFile ? state.activeTargetFile.replace('.txt', '') : '';
        if (cleanName && fs.existsSync(`checkpoint_${cleanName}.json`)) {
            fs.unlinkSync(`checkpoint_${cleanName}.json`);
        }
        
        sock.ws.close();
        sock.ev.removeAllListeners();
        return;

    } catch (e) {
        minimalLog('error', 'fatal scanner failure:\n' + e.stack);
        state.isEngineRunning = false;
        
        minimalLog('system', '[memory dump] saving remaining data to disk...');
        saveReport(); 
        
        process.exit(1);
    }
};

module.exports = { runScanner };