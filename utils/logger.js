// file: utils/logger.js

const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleInfo = console.info;
const originalConsoleError = console.error;
const logListeners = new Set();

// filter terminal output to hide irrelevant baileys logs
const filterTerminalOutput = (...args) => {
    let text = "";
    for (let arg of args) {
        text += (typeof arg === 'string' ? arg : JSON.stringify(arg)) + " ";
    }
    text = text.toLowerCase();
    
    // hide specific verbose logs
    if (text.includes('closing open session') || text.includes('closing session') || text.includes('prekey bundle')) {
        return false;
    }
    return true;
};

// inject stealth filter into native console methods
console.log = function (...args) {
    if (filterTerminalOutput(...args)) originalConsoleLog.apply(console, args);
};
console.warn = function (...args) {
    if (filterTerminalOutput(...args)) originalConsoleWarn.apply(console, args);
};
console.info = function (...args) {
    if (filterTerminalOutput(...args)) originalConsoleInfo.apply(console, args);
};
console.error = function (...args) {
    if (filterTerminalOutput(...args)) originalConsoleError.apply(console, args);
};

// custom lightweight logger
const minimalLog = (context, message) => {
    const timestamp = new Date().toLocaleTimeString('id-ID', { hour12: false });
    const entry = { timestamp, context, message: String(message) };
    for (const listener of logListeners) listener(entry);
    console.log(`[${timestamp}] ${context}: ${message}`);
};

const subscribeLogs = (listener) => {
    logListeners.add(listener);
    return () => logListeners.delete(listener);
};

module.exports = { minimalLog, subscribeLogs };