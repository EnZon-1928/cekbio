const fs = require('fs');
const path = require('path');

const SESSION_PATTERN = /^session_[^/\\\u0000-\u001f]+$/;
const RESULT_PATTERN = /^result_(business|personal|unregistered)_(.+)\.txt$/;
const RESULT_DATA_PATTERN = /^target_(business|personal|unregistered)_.+\.json$/;
const CHECKPOINT_PATTERN = /^checkpoint_.+\.json$/;

const createRuntimePaths = (root = process.cwd()) => {
    const projectRoot = path.resolve(root);
    const senders = path.join(projectRoot, 'senders');
    const targets = path.join(projectRoot, 'targets');
    const results = path.join(projectRoot, 'results');
    const resultData = path.join(projectRoot, 'result-data');
    const checkpoints = path.join(projectRoot, 'checkpoint');
    const logs = path.join(projectRoot, 'logs');

    return {
        root: projectRoot,
        senders,
        targets,
        results,
        resultData,
        checkpoints,
        logs,
        sender: folder => path.join(senders, folder),
        target: filename => path.join(targets, filename),
        result: filename => path.join(results, filename),
        resultDataFile: filename => path.join(resultData, filename),
        checkpoint: filename => path.join(checkpoints, filename),
        log: filename => path.join(logs, filename)
    };
};

const ensureRuntimeDirectories = (root = process.cwd()) => {
    const paths = createRuntimePaths(root);
    for (const directory of [
        paths.senders,
        paths.targets,
        paths.results,
        paths.resultData,
        paths.checkpoints,
        paths.logs
    ]) {
        fs.mkdirSync(directory, { recursive: true });
    }
    return paths;
};

const classifyLegacyEntry = (entry, paths) => {
    if (entry.isDirectory() && SESSION_PATTERN.test(entry.name)) {
        return paths.sender(entry.name);
    }
    if (!entry.isFile()) return null;
    if (RESULT_PATTERN.test(entry.name)) return paths.result(entry.name);
    if (RESULT_DATA_PATTERN.test(entry.name)) return paths.resultDataFile(entry.name);
    if (CHECKPOINT_PATTERN.test(entry.name)) return paths.checkpoint(entry.name);
    if (entry.name === 'log.txt' || entry.name === 'a.log') return paths.log(entry.name);
    if (entry.name.endsWith('.txt') && !entry.name.startsWith('result_')) {
        return paths.target(entry.name);
    }
    return null;
};

const migrateLegacyRuntimeData = (root = process.cwd()) => {
    const paths = ensureRuntimeDirectories(root);
    const entries = fs.readdirSync(paths.root, { withFileTypes: true });
    const migrations = entries
        .map(entry => ({
            source: path.join(paths.root, entry.name),
            destination: classifyLegacyEntry(entry, paths)
        }))
        .filter(migration => migration.destination);

    const conflicts = migrations
        .filter(({ destination }) => fs.existsSync(destination))
        .map(({ source, destination }) =>
            `${path.relative(paths.root, source)} -> ${path.relative(paths.root, destination)}`);
    if (conflicts.length) {
        throw new Error([
            'Legacy data migration stopped because destination files already exist.',
            'No legacy files were moved. Resolve these conflicts and restart cekbio:',
            ...conflicts.map(conflict => `- ${conflict}`)
        ].join('\n'));
    }

    for (const { source, destination } of migrations) {
        const details = fs.lstatSync(source);
        if (details.isDirectory()) {
            fs.cpSync(source, destination, { recursive: true, force: false, errorOnExist: true });
            fs.rmSync(source, { recursive: true });
        } else {
            fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
            fs.unlinkSync(source);
        }
    }

    return paths;
};

module.exports = {
    createRuntimePaths,
    ensureRuntimeDirectories,
    migrateLegacyRuntimeData
};
