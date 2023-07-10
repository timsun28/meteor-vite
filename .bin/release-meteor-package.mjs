import { execSync } from 'child_process';
import Path from 'path';
import FS from 'fs/promises';

const meteorPackage = {
    releaseName: 'vite-bundler',
    packageJsPath: Path.join('./packages/vite-bundler/package.js'),
}

const PACKAGE_VERSION_REGEX = /version:\s*'(?<version>[\d.]+)'\s*,/;

function shell(command) {
    console.log(`$ ${command}`);
    console.log(
        execSync(command).toString('utf-8'),
    )
}

shell('changeset status --output changeset-status.json');
const changesetStatus = FS.readFile('changeset-status.json', 'utf-8').then((content) => {
    return JSON.parse(content);
});

changesetStatus.then(async ({ releases }) => {
    const release = releases.find(({ name }) => meteorPackage.releaseName);

    if (!release) {
        console.log('No pending releases found for %s', meteorPackage.releaseName);
        return;
    }

    console.log(`New version ${release.newVersion} for ${meteorPackage.releaseName} detected`);

    let packageJsContent = await FS.readFile(meteorPackage.packageJsPath, 'utf-8');
    const currentVersion = packageJsContent.match(PACKAGE_VERSION_REGEX)?.groups?.version
    packageJsContent = packageJsContent.replace(PACKAGE_VERSION_REGEX, `version: '${release.newVersion}'`);
    await FS.writeFile(meteorPackage.packageJsPath, packageJsContent);

    console.log(`Changed version in package.js from v${currentVersion} to v${release.newVersion}`);

    shell(`git add ${meteorPackage.packageJsPath}`);
    shell(`git commit -m 'Bump ${meteorPackage.releaseName} version to ${release.newVersion}'`);
})
