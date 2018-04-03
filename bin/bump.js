#!/usr/bin/env node

'use strict';

const Fs = require('fs');
const Path = require('path');

const Hoek = require('hoek');
const Git = require('nodegit');

const internals = {};

const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
const GITHUB_PASSWORD = process.env.GITHUB_PASSWORD;

internals.gitOptions = {
    callbacks: {
        credentials: (url) => {

            // TODO: detect if we should use ssh credentials. see if there's an agent for that we could tap into. How does git do it? The osx keychain helper?
            return Git.Cred.userpassPlaintextNew(GITHUB_USERNAME, GITHUB_PASSWORD);
        }
    }
};

internals.repoHasUncommittedChanges = async function (inputPath) {

    const repo = await Git.Repository.open(inputPath);
    const statuses = await repo.getStatus();
    return (statuses.length > 0);
};

internals.checkoutBranch = async function (inputPath, branchName) {

    const repo = await Git.Repository.open(inputPath);
    return repo.checkoutBranch(branchName);
};

internals.lookupRemote = async function (inputPath, remoteName) {

    const repo = await Git.Repository.open(inputPath);
    return repo.getRemote(remoteName);
};

internals.pull = async function (inputPath) {

    const repo = await Git.Repository.open(inputPath);

    await repo.fetchAll(internals.gitOptions);

    return repo.mergeBranches('master', 'origin/master');
};

internals.push = async function (inputPath, branchName) {

    const remote = await internals.lookupRemote(inputPath, 'origin');
    return remote.push([`refs/heads/${branchName}:refs/heads/${branchName}`], internals.gitOptions);
};

internals.createBranch = async function (inputPath, branchName) {

    const repo = await Git.Repository.open(inputPath);
    const commit = await repo.getHeadCommit();
    return repo.createBranch(branchName, commit, false);
};

internals.commitPaths = async function (inputPath, paths, message) {

    const repo = await Git.Repository.open(inputPath);
    const signature = repo.defaultSignature();
    const index = await repo.refreshIndex();
    for (const path of paths) {
        await index.addByPath(path);
    }
    await index.write();
    const oid = await index.writeTree();
    const head = await repo.getHeadCommit();
    return repo.createCommit('HEAD', signature, signature, message, oid, [head]);
};

exports.bump = async function (inputPath, packageName, beforeVersion, afterVersion) {

    Hoek.assert(GITHUB_USERNAME, 'GITHUB_USERNAME required');
    Hoek.assert(GITHUB_PASSWORD, 'GITHUB_PASSWORD required');

    const packagePath = Path.resolve(inputPath, 'package.json');

    const safeVersion = afterVersion.replace(/[\^\~]/g, '');
    const safePackageName = packageName.replace('@', '').replace('/', '-');

    // fail if there are changes that need stashing
    Hoek.assert(!await internals.repoHasUncommittedChanges(inputPath), `The repo (${inputPath}) has uncommitted changes.`);

    // git checkout master
    await internals.checkoutBranch(inputPath, 'master');

    // git pull
    await internals.pull(inputPath);

    // fail if the current version doesn't match the before version
    const pkg = JSON.parse(Fs.readFileSync(packagePath, 'utf8'));
    const currentVersion = pkg.dependencies[packageName];
    Hoek.assert(currentVersion === beforeVersion, `${currentVersion} must equal ${beforeVersion}`);

    // git checkout -b ${branchName}
    const branchName = `bump-${safePackageName}-v${safeVersion}`;
    await internals.createBranch(inputPath, branchName);
    await internals.checkoutBranch(inputPath, branchName);

    // change the file
    pkg.dependencies[packageName] = afterVersion;
    Fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');

    // add and commit the change
    const commitMessage = `Bump ${safePackageName} to v${safeVersion}`;
    await internals.commitPaths(inputPath, ['package.json'], commitMessage);

    // push the branch
    await internals.push(inputPath, branchName);

    console.log(`Pushed ${branchName}`);

    // TODO: make a new PR
    // TODO: print out the link to the PR
};

if (require.main === module) {
    (async () => {

        try {
            const [inputPath, packageName, beforeVersion, afterVersion] = process.argv.slice(2);
            await exports.bump(inputPath, packageName, beforeVersion, afterVersion);
        }
        catch (error) {
            console.error(error);
            process.exit(1);
        }
    })();
}

