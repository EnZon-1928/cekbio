// file: core/engine.js
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const readline = require('readline');
const fs = require('fs');

const { state } = require('./state');
const { runScanner } = require('./scanner');

const loggerPino = pino({ level: 'silent' });
const askQuestion = (rl) => (question) => new Promise(resolve => rl.question(question, resolve));

const safeLoadJson = (filePath) => {
    if (fs.existsSync(filePath)) {
        try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } 
        catch (e) {
            console.log('\n[!] error reading json at ' + filePath + ':\n' + e.stack);
            return []; 
        }
    }
    return [];
};

const resetState = (isResume = false, cleanName = '') => {
    if (!isResume) {
        state.targetBusiness = [];
        state.targetPersonal = [];
        state.targetUnregistered = [];
        state.statistics = { registered: 0, unregistered: 0, bioBusiness: 0, noBioBusiness: 0, personal: 0 }; 
        state.batchIndex = 0;
    } else {
        state.targetBusiness = safeLoadJson(`target_business_${cleanName}.json`);
        state.targetPersonal = safeLoadJson(`target_personal_${cleanName}.json`);
        state.targetUnregistered = safeLoadJson(`target_unregistered_${cleanName}.json`);
        
        // Recalculate statistics strictly without depending on empty strings.
        state.statistics = {
            registered: state.targetBusiness.length + state.targetPersonal.length,
            unregistered: state.targetUnregistered.length,
            bioBusiness: state.targetBusiness.filter(b => b.bio).length,
            noBioBusiness: state.targetBusiness.filter(b => !b.bio).length,
            personal: state.targetPersonal.length
        };
    }
    state.batches = [];
};

const startEngine = async (returnToMenu) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const prompt = askQuestion(rl);

    try {
        console.clear();
        console.log('=== starting scanner ===');

        const txtFileList = fs.readdirSync('.').filter(f => f.endsWith('.txt') && !f.includes('report_'));
        console.log('\n[ target file list ]');
        
        if (txtFileList.length === 0) {
            console.log(' - no target files found.');
            console.log('returning to menu in 2 seconds...');
            rl.close();
            return setTimeout(returnToMenu, 2000);
        }

        txtFileList.forEach((f, i) => console.log(`${i + 1}. ${f}`));
        console.log('0. cancel and return');
        
        const fileInput = await prompt(`\nselect target file number [0-${txtFileList.length}]: `);
        const fileIndex = parseInt(fileInput);

        if (fileInput === '0' || fileIndex === 0) {
            rl.close();
            return returnToMenu();
        }

        if (isNaN(fileIndex) || fileIndex < 1 || fileIndex > txtFileList.length) {
            console.log('\n[!] invalid selection.');
            rl.close();
            return setTimeout(returnToMenu, 2000);
        }

        const targetFile = txtFileList[fileIndex - 1];
        state.activeTargetFile = targetFile;
        const cleanName = targetFile.replace('.txt', '');

        let isResume = false;
        const checkpointFile = `checkpoint_${cleanName}.json`;
        if (fs.existsSync(checkpointFile)) {
            try {
                const tracker = JSON.parse(fs.readFileSync(checkpointFile, 'utf-8'));
                console.log(`\n[!] scan checkpoint found for [${targetFile}]`);
                console.log(`    (last scan: batch ${tracker.batchIndex}/${tracker.totalBatches})`);
                console.log('1. resume scan (continue from last point)');
                console.log('2. delete checkpoint (start over)');
                console.log('0. cancel');
                
                const resumeChoice = await prompt('select menu [0-2]: ');
                if (resumeChoice === '1') {
                    isResume = true;
                } else if (resumeChoice === '2') {
                    fs.unlinkSync(checkpointFile);
                    isResume = false;
                } else {
                    rl.close();
                    return returnToMenu();
                }
            } catch (e) {
                console.log('\n[!] error reading checkpoint:\n' + e.stack);
                fs.unlinkSync(checkpointFile);
            }
        }

        resetState(isResume, cleanName);
        if (isResume) {
            state.batchIndex = JSON.parse(fs.readFileSync(checkpointFile, 'utf-8')).batchIndex;
        }

        const targetData = fs.readFileSync(targetFile, 'utf-8');
        const numberList = targetData.split('\n').map(n => n.replace(/\D/g, '')).filter(n => n.length > 5);
        
        if (numberList.length === 0) {
            console.log('\n[!] target file is empty or has wrong format.');
            rl.close();
            return setTimeout(returnToMenu, 2000);
        }

        console.log(`\ninfo: ${numberList.length} numbers ready to scan.`);
        const batchSizeInput = await prompt('enter amount of numbers per batch (e.g., 50, type 0 to cancel): ');
        
        if (batchSizeInput === '0') {
            rl.close();
            return returnToMenu();
        }
        
        const batchLimit = parseInt(batchSizeInput) || 50;
        for (let i = 0; i < numberList.length; i += batchLimit) {
            state.batches.push(numberList.slice(i, i + batchLimit));
        }

        const sessionList = fs.readdirSync('.').filter(f => f.startsWith('session_'));
        console.log('\n[ active sender list ]');
        
        if (sessionList.length === 0) {
            console.log(' - no active sender. return and add one first!');
            console.log('returning to menu in 2 seconds...');
            rl.close();
            return setTimeout(returnToMenu, 2000);
        }

        sessionList.forEach((f, i) => console.log(`${i + 1}. ${f.replace('_', ' ')}`));
        console.log('0. cancel and return');

        const sessionInput = await prompt(`\nselect sender number [0-${sessionList.length}]: `);
        const sessionIndex = parseInt(sessionInput);

        if (sessionInput === '0' || sessionIndex === 0) {
            rl.close();
            return returnToMenu();
        }

        if (isNaN(sessionIndex) || sessionIndex < 1 || sessionIndex > sessionList.length) {
            console.log('\n[!] invalid selection.');
            rl.close();
            return setTimeout(returnToMenu, 2000);
        }

        const sessionFolder = sessionList[sessionIndex - 1];

        console.log(`\nconnecting sender [${sessionFolder}]...`);
        rl.close();

        const { state: authState, saveCreds } = await useMultiFileAuthState(sessionFolder);
        const { version } = await fetchLatestBaileysVersion();
        
        const sock = makeWASocket({
            version,
            logger: loggerPino,
            printQRInTerminal: false,
            auth: authState,
            browser: ['My Product', 'Chrome', '10.0'],
            companionPlatformDisplay: 'Chrome (Windows)'
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                console.log(`\n[+] sender connected. initiating scanner!`);
                try {
                    await runScanner(sock);
                } catch (e) {
                    console.log('fatal error while calling scanner:\n' + e.stack);
                }
            } else if (connection === 'close') {
                console.log('\n[!] connection closed. check network or sender status.');
                process.exit(1);
            }
        });

    } catch (e) {
        console.log('\nfatal error in engine bridge:\n' + e.stack);
        rl.close();
        if (returnToMenu) setTimeout(returnToMenu, 3000);
    }
};

module.exports = { startEngine };