// file: core/state.js
const fs = require('fs');
const { minimalLog } = require('../utils/logger');

// Strict memory vault, pure RAM diet active
const state = {
    isEngineRunning: false,
    activeTargetFile: '', 
    batchIndex: 0,
    batches: [],
    targetBusiness: [],
    targetPersonal: [],
    targetUnregistered: [],
    statistics: { registered: 0, unregistered: 0, bioBusiness: 0, noBioBusiness: 0, personal: 0 }
};

const saveReport = () => {
    try {
        const completionTime = new Date().toLocaleString('id-ID');
        const cleanName = state.activeTargetFile ? state.activeTargetFile.replace('.txt', '') : 'unknown';

        if (state.activeTargetFile) {
            fs.writeFileSync(`checkpoint_${cleanName}.json`, JSON.stringify({
                batchIndex: state.batchIndex,
                totalBatches: state.batches.length
            }));
        }

        // 1. Process Business Data
        state.targetBusiness.sort((a, b) => b.tier - a.tier);
        const logBusinessSorted = state.targetBusiness.map(item => item.logString).filter(Boolean);

        fs.writeFileSync(`target_business_${cleanName}.json`, JSON.stringify(state.targetBusiness, null, 4));
        let businessContent = `╔═══════════════════════════════╗\n║ RADAR GATLING - WA BUSINESS   ║\n╚═══════════════════════════════╝\n`;
        businessContent += `∟ 📅 Date          : ${completionTime}\n`;
        businessContent += `∟ 🔢 Total Found   : ${state.targetBusiness.length}\n\n`;
        businessContent += `───────── 📊 SUMMARY ───────────\n`;
        businessContent += `∟ 📝 With Bio/Desc : ${state.statistics.bioBusiness}\n`;
        businessContent += `∟ 📵 No Desc       : ${state.statistics.noBioBusiness}\n\n`;
        businessContent += `──────── 📝 NUMBER DATA ────────\n`;
        businessContent += logBusinessSorted.length > 0 ? logBusinessSorted.join('\n\n') : `   (empty)\n`;
        fs.writeFileSync(`report_business_${cleanName}.txt`, businessContent);

        // 2. Process Personal Data
        fs.writeFileSync(`target_personal_${cleanName}.json`, JSON.stringify(state.targetPersonal, null, 4));
        const mappedPersonalLog = state.targetPersonal.map(data => {
            let bioFormat = data.bio ? data.bio.replace(/\n/g, '\n     │             ') : undefined;
            let logData = `   • ${data.number}\n`;
            if (data.lastUpdate) logData += `     ├─ update    : ${data.lastUpdate}\n`;
            if (bioFormat) logData += `     ├─ bio/desc  : ${bioFormat}\n`;
            
            let lines = logData.trimEnd().split('\n');
            for (let i = lines.length - 1; i >= 0; i--) {
                if (lines[i].includes('├─')) {
                    lines[i] = lines[i].replace('├─', '└─');
                    break;
                }
            }
            return lines.join('\n');
        });
        
        let personalContent = `╔═══════════════════════════════╗\n║ RADAR GATLING - WA PERSONAL   ║\n╚═══════════════════════════════╝\n`;
        personalContent += `∟ 📅 Date          : ${completionTime}\n`;
        personalContent += `∟ 🔢 Total Accounts: ${state.targetPersonal.length}\n\n`;
        personalContent += `──────── 📝 NUMBER DATA ────────\n`;
        personalContent += mappedPersonalLog.length > 0 ? mappedPersonalLog.join('\n\n') : `   (empty)\n`;
        fs.writeFileSync(`report_personal_${cleanName}.txt`, personalContent);

        // 3. Process Unregistered Data
        fs.writeFileSync(`target_unregistered_${cleanName}.json`, JSON.stringify(state.targetUnregistered, null, 4));
        const mappedUnregisteredLog = state.targetUnregistered.map(data => `   • ${data.number}`);
        
        let unregisteredContent = `╔═══════════════════════════════╗\n║ RADAR REPORT - UNREGISTERED   ║\n╚═══════════════════════════════╝\n`;
        unregisteredContent += `∟ 📅 Date          : ${completionTime}\n`;
        unregisteredContent += `∟ 🔢 Total Dead    : ${state.targetUnregistered.length}\n\n`;
        unregisteredContent += `────── 🚫 NOT REGISTERED ───────\n`;
        unregisteredContent += mappedUnregisteredLog.length > 0 ? mappedUnregisteredLog.join('\n') : `   (empty)\n`;
        fs.writeFileSync(`report_unregistered_${cleanName}.txt`, unregisteredContent);

    } catch (e) {
        minimalLog('error', 'failed to execute absolute auto-save:\n' + e.stack);
    }
};

module.exports = { state, saveReport };