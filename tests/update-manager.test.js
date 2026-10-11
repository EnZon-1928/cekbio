const test = require('node:test');
const assert = require('node:assert/strict');

const { createUpdateManager, UPDATE_BRANCH, UPDATE_REPOSITORY } = require('../core/update-manager');

const createGitHarness = ({ commitsBehind = 2, dependenciesChanged = false, dirty = false, diverged = false } = {}) => {
    const calls = [];
    const runGit = async args => {
        calls.push(args);
        const command = args.join(' ');
        if (command === 'rev-parse --abbrev-ref HEAD') return UPDATE_BRANCH;
        if (command === 'diff --quiet HEAD --') {
            if (dirty) throw Object.assign(new Error('local changes'), { code: 1 });
            return '';
        }
        if (args[0] === 'fetch') return '';
        if (command === 'rev-parse HEAD') return 'current';
        if (command === 'rev-parse FETCH_HEAD') return 'latest';
        if (command === 'merge-base --is-ancestor HEAD FETCH_HEAD' && diverged) {
            throw Object.assign(new Error('not ancestor'), { code: 1 });
        }
        if (command === 'merge-base --is-ancestor HEAD FETCH_HEAD') return '';
        if (command === 'rev-list --count HEAD..FETCH_HEAD') return String(commitsBehind);
        if (args[0] === 'diff' && args[1] === '--quiet' && args[2] === 'HEAD' && args[3] === 'FETCH_HEAD') {
            if (dependenciesChanged) throw Object.assign(new Error('dependencies changed'), { code: 1 });
            return '';
        }
        if (args[0] === 'merge' && args[1] === '--ff-only') return '';
        throw new Error(`Unexpected git command: ${command}`);
    };
    return { calls, runGit };
};

test('checks the official telegram_bot branch and reports the available update count', async () => {
    const { calls, runGit } = createGitHarness();
    const manager = createUpdateManager({ root: '/project', runGit });

    assert.deepEqual(await manager.checkForUpdates(), {
        branch: UPDATE_BRANCH,
        commitsBehind: 2,
        currentCommit: 'current',
        latestCommit: 'latest',
        updateAvailable: true
    });
    assert.deepEqual(calls.find(args => args[0] === 'fetch'), [
        'fetch', '--no-tags', UPDATE_REPOSITORY, `refs/heads/${UPDATE_BRANCH}`
    ]);
});

test('applies an available fast-forward and installs changed dependencies', async () => {
    const { calls, runGit } = createGitHarness({ dependenciesChanged: true });
    const events = [];
    const manager = createUpdateManager({
        root: '/project',
        runGit,
        installDependencies: async () => events.push('install')
    });

    const result = await manager.applyUpdate();

    assert.equal(result.updated, true);
    assert.equal(result.dependenciesInstalled, true);
    assert.equal(result.updateAvailable, true);
    assert.ok(calls.some(args => args[0] === 'merge' && args[1] === '--ff-only'));
    assert.deepEqual(events, ['install']);
});

test('does not merge when no updates are available', async () => {
    const { calls, runGit } = createGitHarness({ commitsBehind: 0 });
    const manager = createUpdateManager({ root: '/project', runGit });

    const result = await manager.applyUpdate();

    assert.equal(result.updated, false);
    assert.equal(result.updateAvailable, false);
    assert.equal(calls.some(args => args[0] === 'merge'), false);
});

test('refuses local tracked changes and a diverged branch before changing files', async t => {
    for (const options of [{ dirty: true }, { diverged: true }]) {
        await t.test(JSON.stringify(options), async () => {
            const { calls, runGit } = createGitHarness(options);
            const manager = createUpdateManager({ root: '/project', runGit });

            await assert.rejects(manager.checkForUpdates(), options.dirty
                ? /Tracked files have local changes/
                : /diverged from the official branch/);
            assert.equal(calls.some(args => args[0] === 'merge'), false);
        });
    }
});

test('reports when dependency installation fails after the code fast-forwarded', async () => {
    const { runGit } = createGitHarness({ dependenciesChanged: true });
    const manager = createUpdateManager({
        root: '/project',
        runGit,
        installDependencies: async () => { throw new Error('npm unavailable'); }
    });

    await assert.rejects(manager.applyUpdate(), /application code was updated, but dependencies could not be installed: npm unavailable/);
});
