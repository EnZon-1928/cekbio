// file: io/menu.js
const readline = require('readline');
const fs = require('fs');

const { startEngine } = require('../core/engine');
const { addSender, manageSenderSession } = require('../core/sender');

const askQuestion = (rl) => (question) => new Promise(resolve => rl.question(question, resolve));

const runMainMenu = async () => {
    console.clear();
    console.log('=== main menu ===');
    console.log('1. run scanner');
    console.log('2. add new sender');
    console.log('3. manage senders');
    console.log('0. exit');
    console.log('=================');
    
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const prompt = askQuestion(rl);

    const choice = await prompt('select menu [0-3]: ');
    
    try {
        if (choice === '1') {
            rl.close();
            // inject pure callback to return to menu without breaking stability
            await startEngine(runMainMenu);
        } else if (choice === '2') {
            rl.close();
            await addSender();
            console.log('\nreturning to menu in 2 seconds...');
            setTimeout(runMainMenu, 2000);
        } else if (choice === '3') {
            rl.close();
            await runSenderManagementMenu();
        } else if (choice === '0') {
            console.log('\nshutting down system...');
            rl.close();
            process.exit(0);
        } else {
            console.log('\ninvalid selection.');
            rl.close();
            setTimeout(runMainMenu, 1500);
        }
    } catch (e) {
        console.log('\nfatal error in main menu:\n', e.stack);
        rl.close();
        setTimeout(runMainMenu, 3000);
    }
};

const runSenderManagementMenu = async () => {
    console.clear();
    console.log('=== manage senders ===');
    
    let sessionFolders = [];
    try {
        sessionFolders = fs.readdirSync('.').filter(f => f.startsWith('session_'));
    } catch (e) {
        console.log('failed to track session folders:\n', e.stack);
    }

    console.log(`info: ${sessionFolders.length} sender folders found.`);
    console.log('1. check all senders status');
    console.log('2. check specific sender status');
    console.log('3. delete dead senders (banned/logged out)');
    console.log('0. return to main menu');
    console.log('======================');
    
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const prompt = askQuestion(rl);
    const choice = await prompt('select menu [0-3]: ');
    
    try {
        if (choice === '1') {
            rl.close();
            await manageSenderSession('all', sessionFolders);
            setTimeout(runSenderManagementMenu, 4000);
        } else if (choice === '2') {
            const sessionId = await prompt('enter session number (e.g., 1): ');
            rl.close();
            await manageSenderSession('specific', sessionId);
            setTimeout(runSenderManagementMenu, 4000);
        } else if (choice === '3') {
            rl.close();
            await manageSenderSession('clean', sessionFolders);
            setTimeout(runSenderManagementMenu, 3000);
        } else if (choice === '0') {
            rl.close();
            await runMainMenu();
        } else {
            console.log('\ninvalid selection.');
            rl.close();
            setTimeout(runSenderManagementMenu, 1500);
        }
    } catch (e) {
        console.log('\nfatal error in sub-menu:\n', e.stack);
        rl.close();
        setTimeout(runSenderManagementMenu, 3000);
    }
};

module.exports = { runMainMenu };