const { execFile, spawn } = require('child_process');

const UPDATE_REPOSITORY = 'https://github.com/EnZon-1928/cekbio.git';
const UPDATE_BRANCH = 'telegram_bot';
const GIT_TIMEOUT_MS = 10 * 60 * 1000;
const LIGHTWEIGHT_GIT_TIMEOUT_MS = 15 * 1000;
const UPDATE_HINT_CACHE_MS = 15 * 60 * 1000;

const runGitCommand = (root, args, timeout = GIT_TIMEOUT_MS) => new Promise((resolve, reject) => {
    execFile('git', ['-C', root, ...args], {
        encoding: 'utf8',
        timeout,
        windowsHide: true,
        maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
        if (error) {
            error.stdout = stdout;
            error.stderr = stderr;
            reject(error);
            return;
        }
        resolve(stdout.trim());
    });
});

const runNpmInstall = root => new Promise((resolve, reject) => {
    const child = spawn('npm', ['install'], {
        cwd: root,
        shell: process.platform === 'win32',
        stdio: 'ignore',
        windowsHide: true
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
        if (code === 0) {
            resolve();
            return;
        }
        reject(new Error(signal
            ? `Dependency installation was interrupted (${signal}).`
            : `Dependency installation failed with exit code ${code}.`));
    });
});

const isExitCode = (error, code) => error?.code === code;

const createUpdateManager = ({
    root = process.cwd(),
    runGit,
    runGitLightweight,
    installDependencies = () => runNpmInstall(root),
    now = Date.now
} = {}) => {
    const executeGit = runGit || (args => runGitCommand(root, args));
    const executeLightweightGit = runGitLightweight
        || runGit
        || (args => runGitCommand(root, args, LIGHTWEIGHT_GIT_TIMEOUT_MS));
    let updateHint = null;
    let updateHintPromise = null;

    const ensureExpectedBranch = async () => {
        let branch;
        try {
            branch = await executeGit(['rev-parse', '--abbrev-ref', 'HEAD']);
        } catch (error) {
            throw new Error(`Could not identify the current Git branch: ${error.message}`);
        }
        if (branch !== UPDATE_BRANCH) {
            throw new Error(`Updates are supported only on the ${UPDATE_BRANCH} branch (current: ${branch}).`);
        }
    };

    const ensureTrackedFilesClean = async () => {
        try {
            await executeGit(['diff', '--quiet', 'HEAD', '--']);
        } catch (error) {
            if (isExitCode(error, 1)) {
                throw new Error('Tracked files have local changes. Preserve or commit them before updating.');
            }
            throw new Error(`Could not check local Git changes: ${error.message}`);
        }
    };

    const inspect = async () => {
        await ensureExpectedBranch();
        await ensureTrackedFilesClean();
        try {
            await executeGit([
                'fetch',
                '--no-tags',
                UPDATE_REPOSITORY,
                `refs/heads/${UPDATE_BRANCH}`
            ]);
        } catch (error) {
            throw new Error(`Could not check the official update source: ${error.message}`);
        }

        let currentCommit;
        let latestCommit;
        try {
            [currentCommit, latestCommit] = await Promise.all([
                executeGit(['rev-parse', 'HEAD']),
                executeGit(['rev-parse', 'FETCH_HEAD'])
            ]);
        } catch (error) {
            throw new Error(`Could not read update versions from Git: ${error.message}`);
        }

        try {
            await executeGit(['merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD']);
        } catch (error) {
            if (isExitCode(error, 1)) {
                throw new Error('The local branch has diverged from the official branch. No files were changed.');
            }
            throw new Error(`Could not compare the local and official branches: ${error.message}`);
        }

        let commitsBehind;
        try {
            const output = await executeGit(['rev-list', '--count', 'HEAD..FETCH_HEAD']);
            commitsBehind = Number(output);
            if (!Number.isSafeInteger(commitsBehind) || commitsBehind < 0) {
                throw new Error('Git returned an invalid update count.');
            }
        } catch (error) {
            throw new Error(`Could not count available updates: ${error.message}`);
        }

        return { branch: UPDATE_BRANCH, commitsBehind, currentCommit, latestCommit };
    };

    const checkForUpdates = async () => {
        const status = await inspect();
        return { ...status, updateAvailable: status.commitsBehind > 0 };
    };

    const inspectUpdateHint = async () => {
        const branch = await executeLightweightGit(['rev-parse', '--abbrev-ref', 'HEAD']);
        if (branch !== UPDATE_BRANCH) {
            return { updateAvailable: false, branch, checkedAt: now() };
        }

        const [currentCommit, remoteOutput] = await Promise.all([
            executeLightweightGit(['rev-parse', 'HEAD']),
            executeLightweightGit([
                'ls-remote',
                '--exit-code',
                '--refs',
                UPDATE_REPOSITORY,
                `refs/heads/${UPDATE_BRANCH}`
            ])
        ]);
        const [remoteCommit, remoteRef] = remoteOutput.split(/\s+/);
        if (!/^[a-f0-9]{40,64}$/i.test(remoteCommit || '')
            || remoteRef !== `refs/heads/${UPDATE_BRANCH}`) {
            throw new Error('The official branch returned an invalid commit reference.');
        }
        return {
            updateAvailable: currentCommit.toLowerCase() !== remoteCommit.toLowerCase(),
            branch: UPDATE_BRANCH,
            checkedAt: now()
        };
    };

    const refreshUpdateHint = () => {
        if (updateHint && now() - updateHint.checkedAt < UPDATE_HINT_CACHE_MS) {
            return Promise.resolve(updateHint);
        }
        if (updateHintPromise) return updateHintPromise;

        updateHintPromise = inspectUpdateHint()
            .then(status => {
                updateHint = status;
                return status;
            })
            .catch(error => {
                updateHint = {
                    updateAvailable: false,
                    branch: UPDATE_BRANCH,
                    checkedAt: now(),
                    error
                };
                throw error;
            })
            .finally(() => {
                updateHintPromise = null;
            });
        return updateHintPromise;
    };

    const applyUpdate = async () => {
        const status = await inspect();
        if (status.commitsBehind === 0) {
            return { ...status, updateAvailable: false, updated: false, dependenciesInstalled: false };
        }

        let dependenciesChanged = false;
        try {
            await executeGit([
                'diff',
                '--quiet',
                'HEAD',
                'FETCH_HEAD',
                '--',
                'package.json',
                'package-lock.json'
            ]);
        } catch (error) {
            if (isExitCode(error, 1)) dependenciesChanged = true;
            else throw new Error(`Could not check dependency changes: ${error.message}`);
        }

        try {
            await executeGit(['merge', '--ff-only', 'FETCH_HEAD']);
        } catch (error) {
            throw new Error(`Could not fast-forward to the official update. No local changes were reset: ${error.message}`);
        }

        if (dependenciesChanged) {
            try {
                await installDependencies();
            } catch (error) {
                throw new Error(`The application code was updated, but dependencies could not be installed: ${error.message}`);
            }
        }

        return { ...status, updateAvailable: true, updated: true, dependenciesInstalled: dependenciesChanged };
    };

    return {
        applyUpdate,
        checkForUpdates,
        getCachedUpdateHint: () => updateHint
            && now() - updateHint.checkedAt < UPDATE_HINT_CACHE_MS
            ? updateHint
            : null,
        refreshUpdateHint
    };
};

module.exports = {
    createUpdateManager,
    UPDATE_BRANCH,
    UPDATE_REPOSITORY,
    UPDATE_HINT_CACHE_MS
};
