// file: utils/helpers.js

// Generate random delay between min and max milliseconds
const delay = (min, max) => {
    return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));
};

// Execute a promise with a hard timeout limit to prevent hanging operations
const withTimeout = (promise, timeoutLimit) => {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error("execution timeout reached"));
        }, timeoutLimit);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
};

module.exports = { delay, withTimeout };